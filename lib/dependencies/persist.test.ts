import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  associationKindForAdapter,
  combinedComponentStates,
  computeNextPollAt,
  failureDelayMs,
  isSourceStale,
  matchingIdsForSelector,
  persistSnapshot,
  resolveDependencyState,
  selectorIntersectsIncident,
  worstOf,
  type DependencyNotificationInput,
  type InstalledDependencyRow,
  type PersistExecutor,
  type PersistSourceRow,
  type PersistStore,
} from "./persist";
import type { PollOutcome } from "./poller";
import type { DependencySelector, DependencyState, NormalizedProviderSnapshot } from "./types";

const NOW = new Date("2026-07-19T15:00:00.000Z");

// -- Pure helper tests ----------------------------------------------------

describe("worstOf", () => {
  it("ranks OUTAGE > DEGRADED > MAINTENANCE > OPERATIONAL", () => {
    expect(worstOf(["OPERATIONAL", "MAINTENANCE", "DEGRADED", "OUTAGE"])).toBe("OUTAGE");
    expect(worstOf(["OPERATIONAL", "MAINTENANCE"])).toBe("MAINTENANCE");
    expect(worstOf([])).toBe("OPERATIONAL");
  });
});

function snapshotWith(overrides: Partial<NormalizedProviderSnapshot> = {}): NormalizedProviderSnapshot {
  return {
    sourceId: "vercel",
    observedAt: NOW.toISOString(),
    providerUpdatedAt: NOW.toISOString(),
    components: {},
    incidents: [],
    maintenances: [],
    cache: { etag: null, lastModified: null },
    ...overrides,
  };
}

describe("combinedComponentStates", () => {
  it("folds an active maintenance window into an otherwise-operational component", () => {
    const snapshot = snapshotWith({
      components: { c1: { state: "OPERATIONAL", updatedAt: null } },
      maintenances: [{ externalId: "m1", state: "in_progress", startsAt: "2026-07-19T14:00:00Z", endsAt: "2026-07-19T16:00:00Z", componentIds: ["c1"] }],
    });
    expect(combinedComponentStates(snapshot).get("c1")).toBe("MAINTENANCE");
  });

  it("never downgrades a worse reported state to maintenance", () => {
    const snapshot = snapshotWith({
      components: { c1: { state: "OUTAGE", updatedAt: null } },
      maintenances: [{ externalId: "m1", state: "in_progress", startsAt: "2026-07-19T14:00:00Z", endsAt: null, componentIds: ["c1"] }],
    });
    expect(combinedComponentStates(snapshot).get("c1")).toBe("OUTAGE");
  });

  it("ignores a maintenance window outside its start/end bounds", () => {
    const future = snapshotWith({
      components: { c1: { state: "OPERATIONAL", updatedAt: null } },
      maintenances: [{ externalId: "m1", state: "scheduled", startsAt: "2026-07-20T00:00:00Z", endsAt: null, componentIds: ["c1"] }],
    });
    expect(combinedComponentStates(future).get("c1")).toBe("OPERATIONAL");

    const completed = snapshotWith({
      components: { c1: { state: "OPERATIONAL", updatedAt: null } },
      maintenances: [{ externalId: "m1", state: "completed", startsAt: "2026-07-19T10:00:00Z", endsAt: "2026-07-19T11:00:00Z", componentIds: ["c1"] }],
    });
    expect(combinedComponentStates(completed).get("c1")).toBe("OPERATIONAL");
  });
});

describe("matchingIdsForSelector and resolveDependencyState", () => {
  it("adds the scopeId onto component_ids selectors for both matching and lookup", () => {
    const selector: DependencySelector = { kind: "component_ids", aggregation: "worst_of", ids: ["a"] };
    expect(matchingIdsForSelector(selector, "b")).toEqual(["a", "b"]);
    const snapshot = snapshotWith({ components: { a: { state: "OPERATIONAL", updatedAt: null }, b: { state: "OUTAGE", updatedAt: null } } });
    expect(resolveDependencyState(selector, "b", combinedComponentStates(snapshot), snapshot)).toBe("OUTAGE");
  });

  it("resolves a statusio_component_container selector as worst_of component and container", () => {
    const selector: DependencySelector = { kind: "statusio_component_container", componentId: "comp", container: { required: true } };
    const snapshot = snapshotWith({ components: { comp: { state: "OPERATIONAL", updatedAt: null }, region1: { state: "DEGRADED", updatedAt: null } } });
    expect(resolveDependencyState(selector, "region1", combinedComponentStates(snapshot), snapshot)).toBe("DEGRADED");
  });

  it("treats an unscoped google_product as the bare product's aggregate state", () => {
    const selector: DependencySelector = { kind: "google_product", productId: "prod1" };
    const snapshot = snapshotWith({ components: { prod1: { state: "OUTAGE", updatedAt: null } } });
    expect(resolveDependencyState(selector, null, combinedComponentStates(snapshot), snapshot)).toBe("OUTAGE");
  });

  it("keeps a location-scoped google_product OPERATIONAL when no active incident names that location", () => {
    const selector: DependencySelector = { kind: "google_product", productId: "prod1" };
    const snapshot = snapshotWith({
      components: { prod1: { state: "OUTAGE", updatedAt: null } },
      incidents: [{
        externalId: "inc-1", title: "x", state: "identified", impact: null,
        startedAt: NOW.toISOString(), resolvedAt: null, updatedAt: NOW.toISOString(), canonicalUrl: null,
        componentIds: ["prod1", "prod1@us-east1"], updates: [],
      }],
    });
    // Scoped to a DIFFERENT location than the incident names.
    expect(resolveDependencyState(selector, "eu-west1", combinedComponentStates(snapshot), snapshot)).toBe("OPERATIONAL");
    // Scoped to the SAME location the incident names.
    expect(resolveDependencyState(selector, "us-east1", combinedComponentStates(snapshot), snapshot)).toBe("OUTAGE");
  });
});

describe("associationKindForAdapter and selectorIntersectsIncident", () => {
  it("marks incidentio_compat inferred and every other adapter explicit", () => {
    expect(associationKindForAdapter("incidentio_compat")).toBe("inferred");
    expect(associationKindForAdapter("statuspage_v2")).toBe("explicit");
    expect(associationKindForAdapter("google_cloud_status")).toBe("explicit");
    expect(associationKindForAdapter("statusio_public")).toBe("explicit");
    expect(associationKindForAdapter("sorry_v1")).toBe("explicit");
  });

  it("intersects a selector's matching ids against an incident's componentIds", () => {
    const selector: DependencySelector = { kind: "component_ids", aggregation: "worst_of", ids: ["a", "b"] };
    expect(selectorIntersectsIncident(selector, null, ["b", "c"])).toBe(true);
    expect(selectorIntersectsIncident(selector, null, ["c", "d"])).toBe(false);
  });
});

describe("failureDelayMs and isSourceStale", () => {
  it("follows the 5, 15, 30 minute backoff ladder by consecutive failure count", () => {
    expect(failureDelayMs(1, null)).toBe(5 * 60_000);
    expect(failureDelayMs(2, null)).toBe(15 * 60_000);
    expect(failureDelayMs(3, null)).toBe(30 * 60_000);
    expect(failureDelayMs(10, null)).toBe(30 * 60_000);
  });

  it("honors an explicit Retry-After over the ladder", () => {
    expect(failureDelayMs(1, 2 * 60_000)).toBe(2 * 60_000);
    expect(failureDelayMs(1, 60 * 60_000)).toBe(60 * 60_000);
  });

  it("treats a never-successful source and a source stale past its window as stale", () => {
    expect(isSourceStale(null, 600, NOW)).toBe(true);
    expect(isSourceStale(new Date(NOW.getTime() - 500_000), 600, NOW)).toBe(false);
    expect(isSourceStale(new Date(NOW.getTime() - 700_000), 600, NOW)).toBe(true);
  });
});

describe("computeNextPollAt", () => {
  it("uses the operational interval only when every dependency is operational", () => {
    const source = { operationalPollSeconds: 120, activePollSeconds: 60 };
    expect(computeNextPollAt(true, source, NOW)).toEqual(new Date(NOW.getTime() + 120_000));
    expect(computeNextPollAt(false, source, NOW)).toEqual(new Date(NOW.getTime() + 60_000));
  });
});

// -- persistSnapshot orchestration, against a stateful in-memory fake ------

interface FakeDb {
  installed: InstalledDependencyRow[];
  intervals: Array<{ dependencyId: string; state: string; startedAt: Date; endedAt: Date | null }>;
  incidentsBySourceExternal: Map<string, string>; // `${sourceId}:${externalId}` -> internal id
  incidentComponentPairs: Set<string>;
  incidentUpdatePairs: Set<string>;
  matches: Set<string>;
  outboxKeys: Set<string>;
  notifications: DependencyNotificationInput[];
  sourceHealth: Array<{ kind: string; sourceId: string; patch: unknown }>;
}

function createFakeStore(db: FakeDb): PersistStore {
  const executor: PersistExecutor = {
    async loadInstalledDependencies(sourceId) {
      void sourceId;
      return db.installed.map((row) => ({ ...row }));
    },
    async upsertIncident(sourceId, candidateId, incident) {
      const key = `${sourceId}:${incident.externalId}`;
      const existing = db.incidentsBySourceExternal.get(key);
      if (existing) return existing;
      db.incidentsBySourceExternal.set(key, candidateId);
      return candidateId;
    },
    async upsertIncidentComponents(incidentId, componentIds) {
      for (const componentId of componentIds) db.incidentComponentPairs.add(`${incidentId}:${componentId}`);
    },
    async upsertIncidentUpdates(incidentId, updates) {
      for (const update of updates) db.incidentUpdatePairs.add(`${incidentId}:${update.externalId}`);
    },
    async upsertDependencyIncidentMatch(dependencyId, incidentId) {
      db.matches.add(`${dependencyId}:${incidentId}`);
    },
    async applyDependencyState(dependencyId, previousState, next, now) {
      const row = db.installed.find((dependency) => dependency.id === dependencyId);
      if (row) row.currentState = next.state;
      if (next.state === previousState) return;
      for (const interval of db.intervals) {
        if (interval.dependencyId === dependencyId && interval.endedAt === null) interval.endedAt = now;
      }
      db.intervals.push({ dependencyId, state: next.state, startedAt: now, endedAt: null });
    },
    async enqueueNotification(input, now) {
      void now;
      const key = `${input.sourceId}/${input.incidentExternalId}/${input.presetId}/${input.event}`;
      let inserted = 0;
      for (const recipient of input.recipients) {
        const recipientKey = `${key}/${recipient}`;
        if (db.outboxKeys.has(recipientKey)) continue;
        db.outboxKeys.add(recipientKey);
        inserted += 1;
      }
      if (inserted > 0) db.notifications.push(input);
      return inserted;
    },
    async updateSourceHealthSuccess(sourceId, patch) {
      db.sourceHealth.push({ kind: "success", sourceId, patch });
    },
    async updateSourceHealthNotModified(sourceId, patch) {
      db.sourceHealth.push({ kind: "not_modified", sourceId, patch });
    },
    async updateSourceHealthFailure(sourceId, patch) {
      db.sourceHealth.push({ kind: "failure", sourceId, patch });
    },
  };
  return { transaction: (work) => work(executor) };
}

function emptyDb(installed: InstalledDependencyRow[]): FakeDb {
  return {
    installed,
    intervals: installed.map((row) => ({ dependencyId: row.id, state: row.currentState, startedAt: new Date(0), endedAt: null })),
    incidentsBySourceExternal: new Map(),
    incidentComponentPairs: new Set(),
    incidentUpdatePairs: new Set(),
    matches: new Set(),
    outboxKeys: new Set(),
    notifications: [],
    sourceHealth: [],
  };
}

function baseSource(overrides: Partial<PersistSourceRow> = {}): PersistSourceRow {
  return {
    id: "vercel",
    provider: "Vercel",
    adapter: "statuspage_v2",
    operationalPollSeconds: 120,
    activePollSeconds: 60,
    staleAfterSeconds: 600,
    consecutiveFailures: 0,
    lastSuccessAt: NOW,
    ...overrides,
  };
}

function dependencyRow(overrides: Partial<InstalledDependencyRow> = {}): InstalledDependencyRow {
  return {
    id: "dep-1",
    catalogId: "vercel_runtime",
    presetName: "Vercel Runtime",
    scopeId: null,
    selector: { kind: "component_ids", aggregation: "worst_of", ids: ["c1"] },
    notificationsEnabled: true,
    currentState: "OPERATIONAL" as DependencyState,
    ...overrides,
  };
}

describe("persistSnapshot: not_modified", () => {
  it("refreshes feed health with the operational interval and touches no dependency state", async () => {
    const db = emptyDb([dependencyRow()]);
    const store = createFakeStore(db);
    const outcome: PollOutcome = { sourceId: "vercel", kind: "not_modified", etag: "\"v2\"", lastModified: null };
    const summary = await persistSnapshot(store, outcome, baseSource(), { now: NOW, defaultRecipients: ["ops@example.com"] });

    expect(summary).toEqual({ dependenciesEvaluated: 0, incidentsUpserted: 0, notificationsEnqueued: 0, flippedToUnknown: 0 });
    expect(db.sourceHealth).toEqual([{ kind: "not_modified", sourceId: "vercel", patch: expect.objectContaining({ nextPollAt: new Date(NOW.getTime() + 120_000) }) }]);
    expect(db.intervals).toHaveLength(1);
    expect(db.notifications).toHaveLength(0);
  });

  it("schedules the shorter interval when an existing dependency is not operational", async () => {
    const db = emptyDb([dependencyRow({ currentState: "OUTAGE" })]);
    const store = createFakeStore(db);
    const outcome: PollOutcome = { sourceId: "vercel", kind: "not_modified", etag: null, lastModified: null };
    await persistSnapshot(store, outcome, baseSource(), { now: NOW, defaultRecipients: [] });
    expect(db.sourceHealth[0]?.patch).toMatchObject({ nextPollAt: new Date(NOW.getTime() + 60_000) });
  });
});

describe("persistSnapshot: failure", () => {
  it("backs off without touching dependency state when the source is not yet stale", async () => {
    const db = emptyDb([dependencyRow({ currentState: "OPERATIONAL" })]);
    const store = createFakeStore(db);
    const outcome: PollOutcome = { sourceId: "vercel", kind: "failure", error: Object.assign(new Error("boom"), { code: "HTTP_STATUS" }), retryAfterMs: null };
    const summary = await persistSnapshot(store, outcome, baseSource({ consecutiveFailures: 0, lastSuccessAt: NOW }), { now: NOW, defaultRecipients: [] });

    expect(summary.flippedToUnknown).toBe(0);
    expect(db.sourceHealth).toEqual([{ kind: "failure", sourceId: "vercel", patch: expect.objectContaining({ consecutiveFailures: 1, errorCode: "HTTP_STATUS", nextPollAt: new Date(NOW.getTime() + 5 * 60_000) }) }]);
    expect(db.installed[0]?.currentState).toBe("OPERATIONAL");
    expect(db.notifications).toHaveLength(0);
  });

  it("flips every non-UNKNOWN installed dependency to UNKNOWN, with no notification, once the source is stale", async () => {
    const db = emptyDb([dependencyRow({ id: "dep-1", currentState: "OPERATIONAL" }), dependencyRow({ id: "dep-2", currentState: "UNKNOWN" })]);
    const store = createFakeStore(db);
    const staleLastSuccess = new Date(NOW.getTime() - 700_000);
    const outcome: PollOutcome = { sourceId: "vercel", kind: "failure", error: new Error("boom"), retryAfterMs: null };
    const summary = await persistSnapshot(store, outcome, baseSource({ staleAfterSeconds: 600, lastSuccessAt: staleLastSuccess }), { now: NOW, defaultRecipients: ["ops@example.com"] });

    expect(summary.flippedToUnknown).toBe(1);
    expect(db.installed.find((d) => d.id === "dep-1")?.currentState).toBe("UNKNOWN");
    expect(db.installed.find((d) => d.id === "dep-2")?.currentState).toBe("UNKNOWN");
    expect(db.notifications).toHaveLength(0);
    const dep1Intervals = db.intervals.filter((interval) => interval.dependencyId === "dep-1");
    expect(dep1Intervals.filter((interval) => interval.endedAt === null)).toHaveLength(1);
    expect(dep1Intervals.find((interval) => interval.endedAt === null)?.state).toBe("UNKNOWN");
  });

  it("uses Retry-After for the next poll delay when present", async () => {
    const db = emptyDb([]);
    const store = createFakeStore(db);
    const outcome: PollOutcome = { sourceId: "vercel", kind: "failure", error: new Error("boom"), retryAfterMs: 90_000 };
    await persistSnapshot(store, outcome, baseSource(), { now: NOW, defaultRecipients: [] });
    expect(db.sourceHealth[0]?.patch).toMatchObject({ nextPollAt: new Date(NOW.getTime() + 90_000) });
  });
});

function incident(overrides: Partial<NormalizedProviderSnapshot["incidents"][number]> = {}): NormalizedProviderSnapshot["incidents"][number] {
  return {
    externalId: "inc-1",
    title: "Elevated errors",
    state: "identified",
    impact: "major",
    startedAt: NOW.toISOString(),
    resolvedAt: null,
    updatedAt: NOW.toISOString(),
    canonicalUrl: "https://www.vercel-status.com/incidents/inc-1",
    componentIds: ["c1"],
    updates: [{ externalId: "u1", state: "identified", bodyText: "Investigating", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }],
    ...overrides,
  };
}

describe("persistSnapshot: snapshot state transitions", () => {
  it("opens a new interval on an OPERATIONAL to OUTAGE transition and enqueues one incident notification", async () => {
    const db = emptyDb([dependencyRow()]);
    const store = createFakeStore(db);
    const outcome: PollOutcome = {
      sourceId: "vercel", kind: "snapshot",
      snapshot: snapshotWith({ components: { c1: { state: "OUTAGE", updatedAt: null } }, incidents: [incident()] }),
      etag: "\"v3\"", lastModified: null,
    };
    const summary = await persistSnapshot(store, outcome, baseSource(), { now: NOW, defaultRecipients: ["ops@example.com"] });

    expect(summary.dependenciesEvaluated).toBe(1);
    expect(summary.incidentsUpserted).toBe(1);
    expect(summary.notificationsEnqueued).toBe(1);
    expect(db.installed[0]?.currentState).toBe("OUTAGE");
    const openIntervals = db.intervals.filter((i) => i.dependencyId === "dep-1" && i.endedAt === null);
    expect(openIntervals).toHaveLength(1);
    expect(openIntervals[0]?.state).toBe("OUTAGE");
    expect(db.notifications[0]).toMatchObject({ event: "incident", dependencyName: "Vercel Runtime", provider: "Vercel" });
  });

  it("does not reopen an interval or duplicate a notification when the state is unchanged across two identical polls", async () => {
    const db = emptyDb([dependencyRow({ currentState: "OUTAGE" })]);
    db.intervals[0]!.state = "OUTAGE";
    const store = createFakeStore(db);
    const outcome: PollOutcome = {
      sourceId: "vercel", kind: "snapshot",
      snapshot: snapshotWith({ components: { c1: { state: "OUTAGE", updatedAt: null } }, incidents: [incident()] }),
      etag: "\"v3\"", lastModified: null,
    };
    await persistSnapshot(store, outcome, baseSource(), { now: NOW, defaultRecipients: ["ops@example.com"] });
    await persistSnapshot(store, outcome, baseSource(), { now: new Date(NOW.getTime() + 60_000), defaultRecipients: ["ops@example.com"] });

    // One incident row (upsert idempotent on source+externalId).
    expect(db.incidentsBySourceExternal.size).toBe(1);
    // One notification actually recorded (idempotency key collision suppressed the second attempt).
    expect(db.notifications).toHaveLength(1);
    // Exactly one open interval throughout: the second poll's "unchanged" state never closes/reopens it.
    const openIntervals = db.intervals.filter((i) => i.dependencyId === "dep-1" && i.endedAt === null);
    expect(openIntervals).toHaveLength(1);
  });

  it("enqueues a recovery notification once the matched incident resolves", async () => {
    const db = emptyDb([dependencyRow({ currentState: "OUTAGE" })]);
    const store = createFakeStore(db);
    const resolvedOutcome: PollOutcome = {
      sourceId: "vercel", kind: "snapshot",
      snapshot: snapshotWith({ components: { c1: { state: "OPERATIONAL", updatedAt: null } }, incidents: [incident({ resolvedAt: NOW.toISOString(), updatedAt: NOW.toISOString() })] }),
      etag: null, lastModified: null,
    };
    const summary = await persistSnapshot(store, resolvedOutcome, baseSource(), { now: NOW, defaultRecipients: ["ops@example.com"] });
    expect(summary.notificationsEnqueued).toBe(1);
    expect(db.notifications[0]?.event).toBe("recovery");
    expect(db.installed[0]?.currentState).toBe("OPERATIONAL");
  });

  it("sends no notification when the dependency has notifications disabled, even though the selector matches", async () => {
    const db = emptyDb([dependencyRow({ notificationsEnabled: false })]);
    const store = createFakeStore(db);
    const outcome: PollOutcome = {
      sourceId: "vercel", kind: "snapshot",
      snapshot: snapshotWith({ components: { c1: { state: "OUTAGE", updatedAt: null } }, incidents: [incident()] }),
      etag: null, lastModified: null,
    };
    const summary = await persistSnapshot(store, outcome, baseSource(), { now: NOW, defaultRecipients: ["ops@example.com"] });
    expect(summary.notificationsEnqueued).toBe(0);
    expect(db.installed[0]?.currentState).toBe("OUTAGE");
  });

  it("recovers a dependency from UNKNOWN by adopting the observed state, with no notification for the recovery itself", async () => {
    const db = emptyDb([dependencyRow({ currentState: "UNKNOWN" })]);
    const store = createFakeStore(db);
    const outcome: PollOutcome = {
      sourceId: "vercel", kind: "snapshot",
      snapshot: snapshotWith({ components: { c1: { state: "OPERATIONAL", updatedAt: null } }, incidents: [] }),
      etag: null, lastModified: null,
    };
    const summary = await persistSnapshot(store, outcome, baseSource(), { now: NOW, defaultRecipients: ["ops@example.com"] });
    expect(db.installed[0]?.currentState).toBe("OPERATIONAL");
    expect(summary.notificationsEnqueued).toBe(0);
    expect(db.notifications).toHaveLength(0);
  });

  it("does not match or notify a dependency whose selector does not intersect the incident's components", async () => {
    const db = emptyDb([dependencyRow({ selector: { kind: "component_ids", aggregation: "worst_of", ids: ["other-component"] } })]);
    const store = createFakeStore(db);
    const outcome: PollOutcome = {
      sourceId: "vercel", kind: "snapshot",
      snapshot: snapshotWith({ components: { c1: { state: "OUTAGE", updatedAt: null } }, incidents: [incident()] }),
      etag: null, lastModified: null,
    };
    const summary = await persistSnapshot(store, outcome, baseSource(), { now: NOW, defaultRecipients: ["ops@example.com"] });
    expect(summary.notificationsEnqueued).toBe(0);
    expect(db.matches.size).toBe(0);
  });

  it("schedules the operational interval only once every dependency is OPERATIONAL", async () => {
    const db = emptyDb([dependencyRow({ id: "dep-1" }), dependencyRow({ id: "dep-2", selector: { kind: "component_ids", aggregation: "worst_of", ids: ["c2"] } })]);
    const store = createFakeStore(db);
    const outcome: PollOutcome = {
      sourceId: "vercel", kind: "snapshot",
      snapshot: snapshotWith({ components: { c1: { state: "OPERATIONAL", updatedAt: null }, c2: { state: "DEGRADED", updatedAt: null } } }),
      etag: null, lastModified: null,
    };
    await persistSnapshot(store, outcome, baseSource(), { now: NOW, defaultRecipients: [] });
    expect(db.sourceHealth[0]?.patch).toMatchObject({ nextPollAt: new Date(NOW.getTime() + 60_000) });
  });
});
