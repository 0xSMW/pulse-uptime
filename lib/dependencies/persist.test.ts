import { readFileSync } from "node:fs"

import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  associationKindForAdapter,
  combinedComponentStates,
  computeNextPollAt,
  type DependencyNotificationInput,
  deriveNotificationEvent,
  failureDelayMs,
  type InstalledDependencyRow,
  isSourceStale,
  MAX_RETRY_AFTER_MS,
  matchingIdsForSelector,
  notificationKeyExternalId,
  type PersistExecutor,
  type PersistSourceRow,
  type PersistStore,
  persistSnapshot,
  resolveDependencyState,
  safeProviderUrl,
  selectorIntersectsIncident,
  shouldNotifyDependencyIncident,
  shouldNotifyDependencyRecovery,
  worstOf,
} from "./persist"
import type { PollOutcome } from "./poller"
import type {
  DependencySelector,
  DependencyState,
  IncidentMatchScope,
  NormalizedProviderSnapshot,
} from "./types"
import {
  componentIncidentScope,
  scopeFromComponentIds,
  sourceIncidentScope,
  unmappedIncidentScope,
} from "./types"

const NOW = new Date("2026-07-19T15:00:00.000Z")

// -- Pure helper tests ----------------------------------------------------

describe("worstOf", () => {
  it("ranks OUTAGE > DEGRADED > MAINTENANCE > OPERATIONAL", () => {
    expect(worstOf(["OPERATIONAL", "MAINTENANCE", "DEGRADED", "OUTAGE"])).toBe(
      "OUTAGE"
    )
    expect(worstOf(["OPERATIONAL", "MAINTENANCE"])).toBe("MAINTENANCE")
    expect(worstOf([])).toBe("OPERATIONAL")
  })
})

function snapshotWith(
  overrides: Partial<NormalizedProviderSnapshot> = {}
): NormalizedProviderSnapshot {
  return {
    sourceId: "vercel",
    observedAt: NOW.toISOString(),
    providerUpdatedAt: NOW.toISOString(),
    componentsComplete: true,
    incidentsComplete: true,
    components: {},
    incidents: [],
    maintenances: [],
    cache: { etag: null, lastModified: null },
    ...overrides,
  }
}

describe("combinedComponentStates", () => {
  it("folds an active maintenance window into an otherwise-operational component", () => {
    const snapshot = snapshotWith({
      components: { c1: { state: "OPERATIONAL", updatedAt: null } },
      maintenances: [
        {
          externalId: "m1",
          state: "in_progress",
          startsAt: "2026-07-19T14:00:00Z",
          endsAt: "2026-07-19T16:00:00Z",
          componentIds: ["c1"],
        },
      ],
    })
    expect(combinedComponentStates(snapshot).get("c1")).toBe("MAINTENANCE")
  })

  it("never downgrades a worse reported state to maintenance", () => {
    const snapshot = snapshotWith({
      components: { c1: { state: "OUTAGE", updatedAt: null } },
      maintenances: [
        {
          externalId: "m1",
          state: "in_progress",
          startsAt: "2026-07-19T14:00:00Z",
          endsAt: null,
          componentIds: ["c1"],
        },
      ],
    })
    expect(combinedComponentStates(snapshot).get("c1")).toBe("OUTAGE")
  })

  it("ignores a maintenance window outside its start/end bounds", () => {
    const future = snapshotWith({
      components: { c1: { state: "OPERATIONAL", updatedAt: null } },
      maintenances: [
        {
          externalId: "m1",
          state: "scheduled",
          startsAt: "2026-07-20T00:00:00Z",
          endsAt: null,
          componentIds: ["c1"],
        },
      ],
    })
    expect(combinedComponentStates(future).get("c1")).toBe("OPERATIONAL")

    const completed = snapshotWith({
      components: { c1: { state: "OPERATIONAL", updatedAt: null } },
      maintenances: [
        {
          externalId: "m1",
          state: "completed",
          startsAt: "2026-07-19T10:00:00Z",
          endsAt: "2026-07-19T11:00:00Z",
          componentIds: ["c1"],
        },
      ],
    })
    expect(combinedComponentStates(completed).get("c1")).toBe("OPERATIONAL")
  })
})

describe("matchingIdsForSelector and resolveDependencyState", () => {
  it("keeps both ids for matching an unscoped component_ids selector's own lookup", () => {
    const selector: DependencySelector = {
      kind: "component_ids",
      aggregation: "worst_of",
      ids: ["a"],
    }
    expect(matchingIdsForSelector(selector, "b")).toEqual(["a", "b"])
    const snapshot = snapshotWith({
      components: {
        a: { state: "OPERATIONAL", updatedAt: null },
        b: { state: "OUTAGE", updatedAt: null },
      },
    })
    // Scoped severity comes from the scope child "b" alone.
    expect(
      resolveDependencyState(
        selector,
        "b",
        combinedComponentStates(snapshot),
        snapshot
      )
    ).toBe("OUTAGE")
  })

  it("resolves a scoped component_ids from the scope child alone, not worst_of'd with the parent aggregate (FIX F-A1)", () => {
    // A discovered_children preset: ids name the parent group aggregate, and
    // scopeId names one child region.
    const selector: DependencySelector = {
      kind: "component_ids",
      aggregation: "worst_of",
      ids: ["parent"],
    }
    // The parent aggregates a sibling region's OUTAGE, but the scoped child is
    // fine, so this install stays OPERATIONAL.
    const siblingOut = snapshotWith({
      components: {
        parent: { state: "OUTAGE", updatedAt: null },
        "region-1": { state: "OPERATIONAL", updatedAt: null },
      },
    })
    expect(
      resolveDependencyState(
        selector,
        "region-1",
        combinedComponentStates(siblingOut),
        siblingOut
      )
    ).toBe("OPERATIONAL")
    // The child's own DEGRADED still surfaces.
    const childDegraded = snapshotWith({
      components: {
        parent: { state: "OUTAGE", updatedAt: null },
        "region-1": { state: "DEGRADED", updatedAt: null },
      },
    })
    expect(
      resolveDependencyState(
        selector,
        "region-1",
        combinedComponentStates(childDegraded),
        childDegraded
      )
    ).toBe("DEGRADED")
    // The parent still participates in matching against an incident naming it.
    expect(matchingIdsForSelector(selector, "region-1")).toEqual([
      "parent",
      "region-1",
    ])
    expect(selectorIntersectsIncident(selector, "region-1", ["parent"])).toBe(
      true
    )
    // An absent scope child under a complete feed is UNKNOWN.
    const absent = snapshotWith({
      componentsComplete: true,
      components: { parent: { state: "OPERATIONAL", updatedAt: null } },
    })
    expect(
      resolveDependencyState(
        selector,
        "gone-region",
        combinedComponentStates(absent),
        absent
      )
    ).toBe("UNKNOWN")
  })

  it("resolves an unscoped statusio_component_container selector as the parent component's state", () => {
    const selector: DependencySelector = {
      kind: "statusio_component_container",
      componentId: "comp",
      container: { required: true },
    }
    const snapshot = snapshotWith({
      components: { comp: { state: "DEGRADED", updatedAt: null } },
    })
    expect(
      resolveDependencyState(
        selector,
        null,
        combinedComponentStates(snapshot),
        snapshot
      )
    ).toBe("DEGRADED")
  })

  it("resolves a scoped statusio_component_container from the container alone, not worst_of'd with the parent aggregate", () => {
    const selector: DependencySelector = {
      kind: "statusio_component_container",
      componentId: "comp",
      container: { required: true },
    }
    // The parent aggregates the worst state across every region container.
    // A sibling region's DEGRADED must not surface against the OPERATIONAL
    // region this install is scoped to.
    const parentDegraded = snapshotWith({
      components: {
        comp: { state: "DEGRADED", updatedAt: null },
        region1: { state: "OPERATIONAL", updatedAt: null },
      },
    })
    expect(
      resolveDependencyState(
        selector,
        "region1",
        combinedComponentStates(parentDegraded),
        parentDegraded
      )
    ).toBe("OPERATIONAL")

    // The selected container's own DEGRADED still surfaces.
    const containerDegraded = snapshotWith({
      components: {
        comp: { state: "DEGRADED", updatedAt: null },
        region1: { state: "DEGRADED", updatedAt: null },
      },
    })
    expect(
      resolveDependencyState(
        selector,
        "region1",
        combinedComponentStates(containerDegraded),
        containerDegraded
      )
    ).toBe("DEGRADED")
  })

  it("resolves an absent scoped statusio container to UNKNOWN under a complete feed", () => {
    const selector: DependencySelector = {
      kind: "statusio_component_container",
      componentId: "comp",
      container: { required: true },
    }
    const snapshot = snapshotWith({
      componentsComplete: true,
      components: { comp: { state: "OPERATIONAL", updatedAt: null } },
    })
    expect(
      resolveDependencyState(
        selector,
        "gone-region",
        combinedComponentStates(snapshot),
        snapshot
      )
    ).toBe("UNKNOWN")
  })

  it("still matches a scoped statusio container against an incident naming the parent component", () => {
    const selector: DependencySelector = {
      kind: "statusio_component_container",
      componentId: "comp",
      container: { required: true },
    }
    expect(matchingIdsForSelector(selector, "region1")).toEqual([
      "comp",
      "region1",
    ])
    expect(selectorIntersectsIncident(selector, "region1", ["comp"])).toBe(true)
    expect(selectorIntersectsIncident(selector, "region1", ["region1"])).toBe(
      true
    )
    expect(selectorIntersectsIncident(selector, "region1", ["other"])).toBe(
      false
    )
  })

  it("treats an unscoped google_product as the bare product's aggregate state", () => {
    const selector: DependencySelector = {
      kind: "google_product",
      productId: "prod1",
    }
    const snapshot = snapshotWith({
      components: { prod1: { state: "OUTAGE", updatedAt: null } },
    })
    expect(
      resolveDependencyState(
        selector,
        null,
        combinedComponentStates(snapshot),
        snapshot
      )
    ).toBe("OUTAGE")
  })

  it("keeps a location-scoped google_product OPERATIONAL when no active incident names that location", () => {
    const selector: DependencySelector = {
      kind: "google_product",
      productId: "prod1",
    }
    const snapshot = snapshotWith({
      components: { prod1: { state: "OUTAGE", updatedAt: null } },
      incidents: [
        {
          externalId: "inc-1",
          title: "x",
          state: "identified",
          impact: null,
          startedAt: NOW.toISOString(),
          resolvedAt: null,
          updatedAt: NOW.toISOString(),
          canonicalUrl: null,
          scope: componentIncidentScope(["prod1", "prod1@us-east1"]),
          updates: [],
        },
      ],
    })
    // Scoped to a DIFFERENT location than the incident names.
    expect(
      resolveDependencyState(
        selector,
        "eu-west1",
        combinedComponentStates(snapshot),
        snapshot
      )
    ).toBe("OPERATIONAL")
    // Scoped to the SAME location the incident names.
    expect(
      resolveDependencyState(
        selector,
        "us-east1",
        combinedComponentStates(snapshot),
        snapshot
      )
    ).toBe("OUTAGE")
  })
})

describe("resolveDependencyState: componentsComplete (FIX B)", () => {
  it("resolves UNKNOWN when a selector id is absent from a complete feed", () => {
    const selector: DependencySelector = {
      kind: "component_ids",
      aggregation: "worst_of",
      ids: ["gone"],
    }
    const snapshot = snapshotWith({
      componentsComplete: true,
      components: { other: { state: "OPERATIONAL", updatedAt: null } },
    })
    expect(
      resolveDependencyState(
        selector,
        null,
        combinedComponentStates(snapshot),
        snapshot
      )
    ).toBe("UNKNOWN")
  })

  it("treats an absent selector id as OPERATIONAL when the feed is incomplete (google_cloud_status)", () => {
    const selector: DependencySelector = {
      kind: "google_product",
      productId: "gone",
    }
    const snapshot = snapshotWith({ componentsComplete: false, components: {} })
    expect(
      resolveDependencyState(
        selector,
        null,
        combinedComponentStates(snapshot),
        snapshot
      )
    ).toBe("OPERATIONAL")
  })

  it("still applies worst_of across present ids when every id is present", () => {
    const selector: DependencySelector = {
      kind: "component_ids",
      aggregation: "worst_of",
      ids: ["a", "b"],
    }
    const snapshot = snapshotWith({
      componentsComplete: true,
      components: {
        a: { state: "OPERATIONAL", updatedAt: null },
        b: { state: "DEGRADED", updatedAt: null },
      },
    })
    expect(
      resolveDependencyState(
        selector,
        null,
        combinedComponentStates(snapshot),
        snapshot
      )
    ).toBe("DEGRADED")
  })

  it("resolves UNKNOWN even when a sibling id in the same selector is present and outage-severity", () => {
    const selector: DependencySelector = {
      kind: "component_ids",
      aggregation: "worst_of",
      ids: ["present", "gone"],
    }
    const snapshot = snapshotWith({
      componentsComplete: true,
      components: { present: { state: "OUTAGE", updatedAt: null } },
    })
    expect(
      resolveDependencyState(
        selector,
        null,
        combinedComponentStates(snapshot),
        snapshot
      )
    ).toBe("UNKNOWN")
  })
})

describe("safeProviderUrl (FIX F)", () => {
  const source = {
    statusPageUrl: "https://www.vercel-status.com/",
    allowedHosts: ["www.vercel-status.com"],
  }

  it("rejects a javascript: URL and falls back to the status page", () => {
    expect(safeProviderUrl("javascript:alert(1)", source)).toBe(
      source.statusPageUrl
    )
  })

  it("rejects an offsite https URL not in allowedHosts and falls back to the status page", () => {
    expect(
      safeProviderUrl("https://attacker.example/incidents/1", source)
    ).toBe(source.statusPageUrl)
  })

  it("rejects a non-https URL even on an allowed host", () => {
    expect(
      safeProviderUrl("http://www.vercel-status.com/incidents/1", source)
    ).toBe(source.statusPageUrl)
  })

  it("preserves an https URL on an allowed host", () => {
    expect(
      safeProviderUrl("https://www.vercel-status.com/incidents/1", source)
    ).toBe("https://www.vercel-status.com/incidents/1")
  })

  it("preserves an https URL on the status page's own host even if not separately allowlisted", () => {
    const narrowSource = {
      statusPageUrl: "https://status.example.com/",
      allowedHosts: ["api.example.com"],
    }
    expect(
      safeProviderUrl("https://status.example.com/incidents/1", narrowSource)
    ).toBe("https://status.example.com/incidents/1")
  })

  it("falls back to the status page for null or unparseable input", () => {
    expect(safeProviderUrl(null, source)).toBe(source.statusPageUrl)
    expect(safeProviderUrl("not a url", source)).toBe(source.statusPageUrl)
  })

  // A statuspage_v2 source. The adapter emits the incident permalink on the
  // source's own status page host (see statuspage-v2.ts incidentPermalink),
  // which safeProviderUrl passes through, while the shared stspg.io shortlink
  // stays outside the allowlist and is rewritten to the generic status page.
  describe("statuspage_v2 source permalink versus the stspg.io shortlink", () => {
    const statuspageSource = {
      statusPageUrl: "https://status.anthropic.com/",
      allowedHosts: ["status.anthropic.com"],
    }

    it("preserves the incident permalink on the source's own status page host", () => {
      expect(
        safeProviderUrl(
          "https://status.anthropic.com/incidents/sample1outage01",
          statuspageSource
        )
      ).toBe("https://status.anthropic.com/incidents/sample1outage01")
    })

    it("rewrites a shared stspg.io shortlink to the status page, since that host is not allowlisted", () => {
      expect(
        safeProviderUrl("https://stspg.io/sample1outage01", statuspageSource)
      ).toBe(statuspageSource.statusPageUrl)
    })

    it("still rejects a random host and a non-https permalink for the same source", () => {
      expect(
        safeProviderUrl(
          "https://attacker.example/incidents/1",
          statuspageSource
        )
      ).toBe(statuspageSource.statusPageUrl)
      expect(
        safeProviderUrl(
          "http://status.anthropic.com/incidents/1",
          statuspageSource
        )
      ).toBe(statuspageSource.statusPageUrl)
    })
  })
})

describe("associationKindForAdapter and selectorIntersectsIncident", () => {
  it("marks incidentio_compat inferred and every other adapter explicit", () => {
    expect(associationKindForAdapter("incidentio_compat")).toBe("inferred")
    expect(associationKindForAdapter("statuspage_v2")).toBe("explicit")
    expect(associationKindForAdapter("google_cloud_status")).toBe("explicit")
    expect(associationKindForAdapter("statusio_public")).toBe("explicit")
    expect(associationKindForAdapter("sorry_v1")).toBe("explicit")
  })

  it("intersects a selector's matching ids against an incident's componentIds", () => {
    const selector: DependencySelector = {
      kind: "component_ids",
      aggregation: "worst_of",
      ids: ["a", "b"],
    }
    expect(selectorIntersectsIncident(selector, null, ["b", "c"])).toBe(true)
    expect(selectorIntersectsIncident(selector, null, ["c", "d"])).toBe(false)
  })
})

describe("failureDelayMs and isSourceStale", () => {
  it("follows the 5, 15, 30 minute backoff ladder by consecutive failure count", () => {
    expect(failureDelayMs(1, null)).toBe(5 * 60_000)
    expect(failureDelayMs(2, null)).toBe(15 * 60_000)
    expect(failureDelayMs(3, null)).toBe(30 * 60_000)
    expect(failureDelayMs(10, null)).toBe(30 * 60_000)
  })

  it("honors an explicit Retry-After over the ladder", () => {
    expect(failureDelayMs(1, 2 * 60_000)).toBe(2 * 60_000)
    expect(failureDelayMs(1, 60 * 60_000)).toBe(60 * 60_000)
    expect(failureDelayMs(1, MAX_RETRY_AFTER_MS)).toBe(MAX_RETRY_AFTER_MS)
  })

  it("falls back to the ladder for invalid or oversized Retry-After values", () => {
    expect(failureDelayMs(1, Number.NaN)).toBe(5 * 60_000)
    expect(failureDelayMs(1, Number.POSITIVE_INFINITY)).toBe(5 * 60_000)
    expect(failureDelayMs(1, -1)).toBe(5 * 60_000)
    expect(failureDelayMs(2, MAX_RETRY_AFTER_MS + 1)).toBe(15 * 60_000)
    expect(failureDelayMs(3, Number.NEGATIVE_INFINITY)).toBe(30 * 60_000)
  })

  it("treats a never-successful source and a source stale past its window as stale", () => {
    expect(isSourceStale(null, 600, NOW)).toBe(true)
    expect(isSourceStale(new Date(NOW.getTime() - 500_000), 600, NOW)).toBe(
      false
    )
    expect(isSourceStale(new Date(NOW.getTime() - 700_000), 600, NOW)).toBe(
      true
    )
  })
})

describe("computeNextPollAt", () => {
  it("uses the operational interval only when every dependency is operational", () => {
    const source = { operationalPollSeconds: 120, activePollSeconds: 60 }
    expect(computeNextPollAt(true, source, NOW)).toEqual(
      new Date(NOW.getTime() + 120_000)
    )
    expect(computeNextPollAt(false, source, NOW)).toEqual(
      new Date(NOW.getTime() + 60_000)
    )
  })
})

describe("deriveNotificationEvent", () => {
  it("fires incident for a fresh match on a still-open incident, whether the incident row is new or was already open", () => {
    expect(deriveNotificationEvent(true, true, undefined)).toBe("incident")
    expect(deriveNotificationEvent(true, true, null)).toBe("incident")
  })

  it("fires nothing for a fresh match on an incident already known resolved, new or historical", () => {
    expect(deriveNotificationEvent(true, false, undefined)).toBeNull()
    expect(
      deriveNotificationEvent(true, false, new Date(NOW.getTime() - 1000))
    ).toBeNull()
  })

  it("fires recovery only when a previously open incident is observed resolved for the first time", () => {
    expect(deriveNotificationEvent(false, false, null)).toBe("recovery")
    expect(deriveNotificationEvent(true, false, null)).toBe("recovery")
  })

  it("fires nothing for an incident already resolved as of the prior poll, regardless of match newness", () => {
    expect(
      deriveNotificationEvent(false, false, new Date(NOW.getTime() - 1000))
    ).toBeNull()
    expect(
      deriveNotificationEvent(true, false, new Date(NOW.getTime() - 1000))
    ).toBeNull()
  })

  it("fires nothing for an unchanged still-open match", () => {
    expect(deriveNotificationEvent(false, true, null)).toBeNull()
    expect(deriveNotificationEvent(false, true, undefined)).toBeNull()
  })

  it("fires incident for a reopen: an existing match observed active again on an incident stored resolved", () => {
    expect(
      deriveNotificationEvent(false, true, new Date(NOW.getTime() - 1000))
    ).toBe("incident")
  })

  it("fires incident for a reopen even when the dependency first matches the reopened active incident on this poll", () => {
    expect(
      deriveNotificationEvent(true, true, new Date(NOW.getTime() - 1000))
    ).toBe("incident")
  })
})

describe("notificationKeyExternalId", () => {
  it("keeps a first-time incident's external id bare", () => {
    expect(
      notificationKeyExternalId("incident", "inc-1", false, undefined, null)
    ).toBe("inc-1")
    expect(
      notificationKeyExternalId("incident", "inc-1", false, null, null)
    ).toBe("inc-1")
  })

  it("appends the prior resolved timestamp for a reopen incident", () => {
    const priorResolvedAt = new Date(NOW.getTime() - 60_000)
    expect(
      notificationKeyExternalId(
        "incident",
        "inc-1",
        true,
        priorResolvedAt,
        null
      )
    ).toBe(`inc-1#${priorResolvedAt.getTime()}`)
  })

  it("always appends the reported resolvedAt timestamp for a recovery, distinct across cycles", () => {
    const firstResolution = NOW.toISOString()
    const secondResolution = new Date(NOW.getTime() + 120_000).toISOString()
    const firstKey = notificationKeyExternalId(
      "recovery",
      "inc-1",
      false,
      null,
      firstResolution
    )
    const secondKey = notificationKeyExternalId(
      "recovery",
      "inc-1",
      false,
      null,
      secondResolution
    )
    expect(firstKey).toBe(`inc-1#${new Date(firstResolution).getTime()}`)
    expect(firstKey).not.toBe(secondKey)
  })
})

// -- persistSnapshot orchestration, against a stateful in-memory fake ------

interface FakeDb {
  installed: InstalledDependencyRow[]
  intervals: Array<{
    dependencyId: string
    state: string
    startedAt: Date
    endedAt: Date | null
  }>
  incidentsBySourceExternal: Map<string, string> // `${sourceId}:${externalId}` -> internal id
  incidentResolvedAt: Map<string, Date | null> // `${sourceId}:${externalId}` -> stored resolved_at
  incidentMeta: Map<
    string,
    {
      sourceId: string
      externalId: string
      title: string
      canonicalUrl: string | null
      startedAt: Date
    }
  > // internal id -> stored fields
  upsertedCanonicalUrls: Map<string, string | null> // internal incident id -> canonicalUrl as passed to upsertIncident
  incidentComponentPairs: Set<string>
  incidentUpdatePairs: Set<string>
  matches: Set<string> // `${dependencyId}:${incidentId}` pairs already matched in a prior poll
  lastSuccessfulPollAt: Map<string, Date> // dependencyId -> last_successful_poll_at, advanced only on a real snapshot
  outboxKeys: Set<string>
  notifications: DependencyNotificationInput[]
  sourceHealth: Array<{ kind: string; sourceId: string; patch: unknown }>
}

// Deep-copies every mutable container on the fake db, so a transaction that
// throws partway through can restore exactly the state that existed before
// it started, the same way a real Postgres transaction's rollback discards
// every write made on its connection, not just the last one.
function snapshotFakeDb(db: FakeDb): FakeDb {
  return {
    installed: db.installed.map((row) => ({ ...row })),
    intervals: db.intervals.map((interval) => ({ ...interval })),
    incidentsBySourceExternal: new Map(db.incidentsBySourceExternal),
    incidentResolvedAt: new Map(db.incidentResolvedAt),
    incidentMeta: new Map(
      [...db.incidentMeta].map(([id, meta]) => [id, { ...meta }])
    ),
    upsertedCanonicalUrls: new Map(db.upsertedCanonicalUrls),
    incidentComponentPairs: new Set(db.incidentComponentPairs),
    incidentUpdatePairs: new Set(db.incidentUpdatePairs),
    matches: new Set(db.matches),
    lastSuccessfulPollAt: new Map(db.lastSuccessfulPollAt),
    outboxKeys: new Set(db.outboxKeys),
    notifications: [...db.notifications],
    sourceHealth: [...db.sourceHealth],
  }
}

function restoreFakeDb(db: FakeDb, snapshot: FakeDb): void {
  db.installed = snapshot.installed
  db.intervals = snapshot.intervals
  db.incidentsBySourceExternal = snapshot.incidentsBySourceExternal
  db.incidentResolvedAt = snapshot.incidentResolvedAt
  db.incidentMeta = snapshot.incidentMeta
  db.upsertedCanonicalUrls = snapshot.upsertedCanonicalUrls
  db.incidentComponentPairs = snapshot.incidentComponentPairs
  db.incidentUpdatePairs = snapshot.incidentUpdatePairs
  db.matches = snapshot.matches
  db.lastSuccessfulPollAt = snapshot.lastSuccessfulPollAt
  db.outboxKeys = snapshot.outboxKeys
  db.notifications = snapshot.notifications
  db.sourceHealth = snapshot.sourceHealth
}

function createExecutor(db: FakeDb): PersistExecutor {
  return {
    async loadInstalledDependencies(sourceId) {
      void sourceId
      return db.installed.map((row) => ({ ...row }))
    },
    async loadPriorIncidentResolution(sourceId, externalIds) {
      const result = new Map<string, Date | null>()
      for (const externalId of externalIds) {
        const key = `${sourceId}:${externalId}`
        if (db.incidentResolvedAt.has(key)) {
          result.set(externalId, db.incidentResolvedAt.get(key)!)
        }
      }
      return result
    },
    async upsertIncident(sourceId, candidateId, incidentInput) {
      const key = `${sourceId}:${incidentInput.externalId}`
      const existing = db.incidentsBySourceExternal.get(key)
      const internalId = existing ?? candidateId
      db.upsertedCanonicalUrls.set(internalId, incidentInput.canonicalUrl)
      db.incidentResolvedAt.set(
        key,
        incidentInput.resolvedAt ? new Date(incidentInput.resolvedAt) : null
      )
      // Mirrors the real ON CONFLICT SET, which re-anchors started_at on every
      // upsert (FIX F-A4): an unchanged poll rewrites the same value, a reopen
      // rewrites the reopen's new started time.
      db.incidentMeta.set(internalId, {
        sourceId,
        externalId: incidentInput.externalId,
        title: incidentInput.title,
        canonicalUrl: incidentInput.canonicalUrl,
        startedAt: new Date(incidentInput.startedAt),
      })
      if (existing) {
        return existing
      }
      db.incidentsBySourceExternal.set(key, candidateId)
      return candidateId
    },
    async loadOpenIncidents(sourceId) {
      const result: Array<{
        internalId: string
        externalId: string
        title: string
        canonicalUrl: string | null
      }> = []
      for (const [internalId, meta] of db.incidentMeta) {
        if (meta.sourceId !== sourceId) {
          continue
        }
        const resolvedAt = db.incidentResolvedAt.get(
          `${meta.sourceId}:${meta.externalId}`
        )
        if (resolvedAt) {
          continue
        }
        result.push({
          internalId,
          externalId: meta.externalId,
          title: meta.title,
          canonicalUrl: meta.canonicalUrl,
        })
      }
      return result
    },
    async closeIncident(internalId, resolvedAt) {
      const meta = db.incidentMeta.get(internalId)
      if (!meta) {
        return
      }
      // Mirrors the real greatest(resolvedAt, started_at) guard (FIX F3): a
      // stored-open incident whose started_at is ahead of now resolves at its
      // own started_at, never before it, so the resolution-order check holds.
      const guarded =
        resolvedAt.getTime() >= meta.startedAt.getTime()
          ? resolvedAt
          : meta.startedAt
      db.incidentResolvedAt.set(`${meta.sourceId}:${meta.externalId}`, guarded)
    },
    async upsertIncidentComponents(incidentId, componentIds) {
      for (const componentId of componentIds) {
        db.incidentComponentPairs.add(`${incidentId}:${componentId}`)
      }
    },
    async upsertIncidentUpdates(incidentId, updates) {
      for (const update of updates) {
        db.incidentUpdatePairs.add(`${incidentId}:${update.externalId}`)
      }
    },
    async upsertDependencyIncidentMatch(dependencyId, incidentId) {
      const key = `${dependencyId}:${incidentId}`
      const isNewMatch = !db.matches.has(key)
      db.matches.add(key)
      return isNewMatch
    },
    async loadExistingMatches(incidentIds) {
      const idSet = new Set(incidentIds)
      const result = new Set<string>()
      for (const key of db.matches) {
        const incidentId = key.slice(key.indexOf(":") + 1)
        if (idSet.has(incidentId)) {
          result.add(key)
        }
      }
      return result
    },
    async applyDependencyState(dependencyId, previousState, next, now) {
      const row = db.installed.find(
        (dependency) => dependency.id === dependencyId
      )
      if (row) {
        row.currentState = next.state
      }
      // Only a real snapshot advances the success timestamp (FIX F-A5).
      if (next.pollSucceeded) {
        db.lastSuccessfulPollAt.set(dependencyId, now)
      }
      if (next.state === previousState) {
        return
      }
      for (const interval of db.intervals) {
        if (
          interval.dependencyId === dependencyId &&
          interval.endedAt === null
        ) {
          interval.endedAt = now
        }
      }
      db.intervals.push({
        dependencyId,
        state: next.state,
        startedAt: now,
        endedAt: null,
      })
    },
    async enqueueNotification(input, now) {
      void now
      const key = `${input.sourceId}/${input.incidentExternalId}/${input.presetId}/${input.scopeId ?? ""}/${input.event}`
      let inserted = 0
      for (const recipient of input.recipients) {
        const recipientKey = `${key}/${recipient}`
        if (db.outboxKeys.has(recipientKey)) {
          continue
        }
        db.outboxKeys.add(recipientKey)
        inserted += 1
      }
      if (inserted > 0) {
        db.notifications.push(input)
      }
      return inserted
    },
    async updateSourceHealthSuccess(sourceId, patch) {
      db.sourceHealth.push({ kind: "success", sourceId, patch })
    },
    async updateSourceHealthNotModified(sourceId, patch) {
      db.sourceHealth.push({ kind: "not_modified", sourceId, patch })
    },
    async updateSourceHealthFailure(sourceId, patch) {
      db.sourceHealth.push({ kind: "failure", sourceId, patch })
    },
  }
}

// Mirrors a real Postgres transaction's atomicity: every write the executor
// makes lands on `db` immediately (so existing assertions that inspect `db`
// mid-test still work), but a throw anywhere in `work` restores the
// pre-transaction snapshot before propagating, so nothing the failed
// transaction wrote is left behind. Every test below that never throws
// commits exactly as before this wrapper existed.
function createFakeStore(
  db: FakeDb,
  executor: PersistExecutor = createExecutor(db)
): PersistStore {
  return {
    transaction: async (work) => {
      const snapshot = snapshotFakeDb(db)
      try {
        return await work(executor)
      } catch (error) {
        restoreFakeDb(db, snapshot)
        throw error
      }
    },
  }
}

function emptyDb(installed: InstalledDependencyRow[]): FakeDb {
  return {
    installed,
    intervals: installed.map((row) => ({
      dependencyId: row.id,
      state: row.currentState,
      startedAt: new Date(0),
      endedAt: null,
    })),
    incidentsBySourceExternal: new Map(),
    incidentResolvedAt: new Map(),
    incidentMeta: new Map(),
    upsertedCanonicalUrls: new Map(),
    incidentComponentPairs: new Set(),
    incidentUpdatePairs: new Set(),
    matches: new Set(),
    lastSuccessfulPollAt: new Map(),
    outboxKeys: new Set(),
    notifications: [],
    sourceHealth: [],
  }
}

function baseSource(
  overrides: Partial<PersistSourceRow> = {}
): PersistSourceRow {
  return {
    id: "vercel",
    provider: "Vercel",
    adapter: "statuspage_v2",
    statusPageUrl: "https://www.vercel-status.com/",
    allowedHosts: ["www.vercel-status.com"],
    operationalPollSeconds: 120,
    activePollSeconds: 60,
    staleAfterSeconds: 600,
    consecutiveFailures: 0,
    lastSuccessAt: NOW,
    ...overrides,
  }
}

function dependencyRow(
  overrides: Partial<InstalledDependencyRow> = {}
): InstalledDependencyRow {
  return {
    id: "dep-1",
    catalogId: "vercel_runtime",
    presetName: "Vercel Runtime",
    scopeId: null,
    selector: { kind: "component_ids", aggregation: "worst_of", ids: ["c1"] },
    fidelity: "component",
    notificationsEnabled: true,
    currentState: "OPERATIONAL" as DependencyState,
    ...overrides,
  }
}

describe("persistSnapshot: not_modified", () => {
  it("refreshes feed health with the operational interval and touches no dependency state", async () => {
    const db = emptyDb([dependencyRow()])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "not_modified",
      etag: '"v2"',
      lastModified: null,
    }
    const summary = await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })

    expect(summary).toEqual({
      dependenciesEvaluated: 0,
      incidentsUpserted: 0,
      notificationsEnqueued: 0,
      flippedToUnknown: 0,
    })
    expect(db.sourceHealth).toEqual([
      {
        kind: "not_modified",
        sourceId: "vercel",
        patch: expect.objectContaining({
          nextPollAt: new Date(NOW.getTime() + 120_000),
        }),
      },
    ])
    expect(db.intervals).toHaveLength(1)
    expect(db.notifications).toHaveLength(0)
  })

  it("schedules the shorter interval when an existing dependency is not operational", async () => {
    const db = emptyDb([dependencyRow({ currentState: "OUTAGE" })])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "not_modified",
      etag: null,
      lastModified: null,
    }
    await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: [],
    })
    expect(db.sourceHealth[0]?.patch).toMatchObject({
      nextPollAt: new Date(NOW.getTime() + 60_000),
    })
  })
})

describe("persistSnapshot: failure", () => {
  it("backs off without touching dependency state when the source is not yet stale", async () => {
    const db = emptyDb([dependencyRow({ currentState: "OPERATIONAL" })])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "failure",
      error: Object.assign(new Error("boom"), { code: "HTTP_STATUS" }),
      retryAfterMs: null,
    }
    const summary = await persistSnapshot(
      store,
      outcome,
      baseSource({ consecutiveFailures: 0, lastSuccessAt: NOW }),
      { now: NOW, defaultRecipients: [] }
    )

    expect(summary.flippedToUnknown).toBe(0)
    expect(db.sourceHealth).toEqual([
      {
        kind: "failure",
        sourceId: "vercel",
        patch: expect.objectContaining({
          consecutiveFailures: 1,
          errorCode: "HTTP_STATUS",
          nextPollAt: new Date(NOW.getTime() + 5 * 60_000),
        }),
      },
    ])
    expect(db.installed[0]?.currentState).toBe("OPERATIONAL")
    expect(db.notifications).toHaveLength(0)
  })

  it("flips every non-UNKNOWN installed dependency to UNKNOWN, with no notification, once the source is stale", async () => {
    const db = emptyDb([
      dependencyRow({ id: "dep-1", currentState: "OPERATIONAL" }),
      dependencyRow({ id: "dep-2", currentState: "UNKNOWN" }),
    ])
    const store = createFakeStore(db)
    const staleLastSuccess = new Date(NOW.getTime() - 700_000)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "failure",
      error: new Error("boom"),
      retryAfterMs: null,
    }
    const summary = await persistSnapshot(
      store,
      outcome,
      baseSource({ staleAfterSeconds: 600, lastSuccessAt: staleLastSuccess }),
      { now: NOW, defaultRecipients: ["ops@example.com"] }
    )

    expect(summary.flippedToUnknown).toBe(1)
    expect(db.installed.find((d) => d.id === "dep-1")?.currentState).toBe(
      "UNKNOWN"
    )
    expect(db.installed.find((d) => d.id === "dep-2")?.currentState).toBe(
      "UNKNOWN"
    )
    expect(db.notifications).toHaveLength(0)
    const dep1Intervals = db.intervals.filter(
      (interval) => interval.dependencyId === "dep-1"
    )
    expect(
      dep1Intervals.filter((interval) => interval.endedAt === null)
    ).toHaveLength(1)
    expect(
      dep1Intervals.find((interval) => interval.endedAt === null)?.state
    ).toBe("UNKNOWN")
  })

  it("uses Retry-After for the next poll delay when present", async () => {
    const db = emptyDb([])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "failure",
      error: new Error("boom"),
      retryAfterMs: 90_000,
    }
    await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: [],
    })
    expect(db.sourceHealth[0]?.patch).toMatchObject({
      nextPollAt: new Date(NOW.getTime() + 90_000),
    })
  })
})

/** Test helper. Accepts either `scope` or legacy `componentIds` shorthand (empty → unmapped). */
function incident(
  overrides: Partial<NormalizedProviderSnapshot["incidents"][number]> & {
    componentIds?: string[]
  } = {}
): NormalizedProviderSnapshot["incidents"][number] {
  const { componentIds, ...rest } = overrides
  const scope: IncidentMatchScope =
    rest.scope ??
    (componentIds === undefined
      ? componentIncidentScope(["c1"])
      : scopeFromComponentIds(componentIds))
  return {
    externalId: "inc-1",
    title: "Elevated errors",
    state: "identified",
    impact: "major",
    startedAt: NOW.toISOString(),
    resolvedAt: null,
    updatedAt: NOW.toISOString(),
    canonicalUrl: "https://www.vercel-status.com/incidents/inc-1",
    updates: [
      {
        externalId: "u1",
        state: "identified",
        bodyText: "Investigating",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    ],
    ...rest,
    scope,
  }
}

describe("persistSnapshot: snapshot state transitions", () => {
  it("opens a new interval on an OPERATIONAL to OUTAGE transition and enqueues one incident notification", async () => {
    const db = emptyDb([dependencyRow()])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [incident()],
      }),
      etag: '"v3"',
      lastModified: null,
    }
    const summary = await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })

    expect(summary.dependenciesEvaluated).toBe(1)
    expect(summary.incidentsUpserted).toBe(1)
    expect(summary.notificationsEnqueued).toBe(1)
    expect(db.installed[0]?.currentState).toBe("OUTAGE")
    const openIntervals = db.intervals.filter(
      (i) => i.dependencyId === "dep-1" && i.endedAt === null
    )
    expect(openIntervals).toHaveLength(1)
    expect(openIntervals[0]?.state).toBe("OUTAGE")
    expect(db.notifications[0]).toMatchObject({
      event: "incident",
      dependencyName: "Vercel Runtime",
      provider: "Vercel",
    })
  })

  it("does not reopen an interval or duplicate a notification when the state is unchanged across two identical polls", async () => {
    const db = emptyDb([dependencyRow({ currentState: "OUTAGE" })])
    db.intervals[0]!.state = "OUTAGE"
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [incident()],
      }),
      etag: '"v3"',
      lastModified: null,
    }
    await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })
    await persistSnapshot(store, outcome, baseSource(), {
      now: new Date(NOW.getTime() + 60_000),
      defaultRecipients: ["ops@example.com"],
    })

    // One incident row (upsert idempotent on source+externalId).
    expect(db.incidentsBySourceExternal.size).toBe(1)
    // One notification recorded: the second poll's match is no longer new
    // and the incident is still active, so FIX A's transition rule doesn't
    // even attempt a second enqueue (the outbox key would have caught it
    // regardless, but the newness check is what actually gates it here).
    expect(db.notifications).toHaveLength(1)
    // Exactly one open interval throughout: the second poll's "unchanged" state never closes/reopens it.
    const openIntervals = db.intervals.filter(
      (i) => i.dependencyId === "dep-1" && i.endedAt === null
    )
    expect(openIntervals).toHaveLength(1)
  })

  it("sends no notification when the dependency has notifications disabled, even though the selector matches", async () => {
    const db = emptyDb([dependencyRow({ notificationsEnabled: false })])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [incident()],
      }),
      etag: null,
      lastModified: null,
    }
    const summary = await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })
    expect(summary.notificationsEnqueued).toBe(0)
    expect(db.installed[0]?.currentState).toBe("OUTAGE")
  })

  it("recovers a dependency from UNKNOWN by adopting the observed state, with no notification for the recovery itself", async () => {
    const db = emptyDb([dependencyRow({ currentState: "UNKNOWN" })])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [],
      }),
      etag: null,
      lastModified: null,
    }
    const summary = await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })
    expect(db.installed[0]?.currentState).toBe("OPERATIONAL")
    expect(summary.notificationsEnqueued).toBe(0)
    expect(db.notifications).toHaveLength(0)
  })

  it("does not match or notify a dependency whose selector does not intersect the incident's components", async () => {
    const db = emptyDb([
      dependencyRow({
        selector: {
          kind: "component_ids",
          aggregation: "worst_of",
          ids: ["other-component"],
        },
      }),
    ])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [incident()],
      }),
      etag: null,
      lastModified: null,
    }
    const summary = await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })
    expect(summary.notificationsEnqueued).toBe(0)
    expect(db.matches.size).toBe(0)
  })

  it("schedules the operational interval only once every dependency is OPERATIONAL", async () => {
    const db = emptyDb([
      dependencyRow({ id: "dep-1" }),
      dependencyRow({
        id: "dep-2",
        selector: {
          kind: "component_ids",
          aggregation: "worst_of",
          ids: ["c2"],
        },
      }),
    ])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: {
          c1: { state: "OPERATIONAL", updatedAt: null },
          c2: { state: "DEGRADED", updatedAt: null },
        },
      }),
      etag: null,
      lastModified: null,
    }
    await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: [],
    })
    expect(db.sourceHealth[0]?.patch).toMatchObject({
      nextPollAt: new Date(NOW.getTime() + 60_000),
    })
  })
})

// -- FIX A: match-row newness is the incident/recovery transition signal ---
//
// Consequence table from the adversarial review: (1) a historical resolved
// matching incident found on install sends nothing, (2) an active ongoing
// incident found on install sends one incident alert, (3) that incident
// later resolving sends exactly one recovery, (4) an incident that opens
// and resolves within a single poll gap (newly matched already-resolved)
// sends nothing. The dependency_incident_matches row's newness this poll,
// not resolved/open alone, is what tells "just started matching" apart
// from "still matching, same as last poll".

describe("persistSnapshot: FIX A notification transitions", () => {
  it("(1) sends nothing when a historical resolved incident matches on install", async () => {
    const db = emptyDb([dependencyRow({ currentState: "UNKNOWN" })])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incident({
            resolvedAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }
    const summary = await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })

    expect(summary.notificationsEnqueued).toBe(0)
    expect(db.notifications).toHaveLength(0)
    // The match itself is still recorded: only the notification is suppressed.
    expect(db.matches.size).toBe(1)
  })

  it("(2) sends one incident alert when an active ongoing incident matches on install", async () => {
    const db = emptyDb([dependencyRow({ currentState: "OPERATIONAL" })])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [incident()],
      }),
      etag: null,
      lastModified: null,
    }
    const summary = await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })

    expect(summary.notificationsEnqueued).toBe(1)
    expect(db.notifications).toHaveLength(1)
    expect(db.notifications[0]?.event).toBe("incident")
  })

  it("(3) sends exactly one recovery when that incident later resolves", async () => {
    const db = emptyDb([dependencyRow({ currentState: "OPERATIONAL" })])
    const store = createFakeStore(db)
    const openOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [incident()],
      }),
      etag: null,
      lastModified: null,
    }
    const resolvedOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incident({
            resolvedAt: new Date(NOW.getTime() + 60_000).toISOString(),
            updatedAt: new Date(NOW.getTime() + 60_000).toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }

    await persistSnapshot(store, openOutcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })
    const summary = await persistSnapshot(
      store,
      resolvedOutcome,
      baseSource(),
      {
        now: new Date(NOW.getTime() + 60_000),
        defaultRecipients: ["ops@example.com"],
      }
    )

    expect(summary.notificationsEnqueued).toBe(1)
    expect(db.notifications).toHaveLength(2)
    expect(db.notifications[0]?.event).toBe("incident")
    expect(db.notifications[1]?.event).toBe("recovery")
    expect(db.installed[0]?.currentState).toBe("OPERATIONAL")
  })

  it("(4) sends nothing for an incident that opens and resolves within one poll gap (newly matched, already resolved)", async () => {
    const db = emptyDb([dependencyRow({ currentState: "OPERATIONAL" })])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incident({
            startedAt: NOW.toISOString(),
            resolvedAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }
    const summary = await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })

    expect(summary.notificationsEnqueued).toBe(0)
    expect(db.notifications).toHaveLength(0)
    expect(db.matches.size).toBe(1)
  })
})

describe("persistSnapshot: repeated polls of an unchanged historical feed", () => {
  it("enqueues zero notifications on the second and third poll of an install feed full of already-resolved incidents", async () => {
    const db = emptyDb([dependencyRow({ currentState: "OPERATIONAL" })])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incident({
            externalId: "inc-old-1",
            resolvedAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          }),
          incident({
            externalId: "inc-old-2",
            resolvedAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }

    const poll1 = await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })
    const poll2 = await persistSnapshot(store, outcome, baseSource(), {
      now: new Date(NOW.getTime() + 60_000),
      defaultRecipients: ["ops@example.com"],
    })
    const poll3 = await persistSnapshot(store, outcome, baseSource(), {
      now: new Date(NOW.getTime() + 120_000),
      defaultRecipients: ["ops@example.com"],
    })

    expect(poll1.notificationsEnqueued).toBe(0)
    expect(poll2.notificationsEnqueued).toBe(0)
    expect(poll3.notificationsEnqueued).toBe(0)
    expect(db.notifications).toHaveLength(0)
    // Both historical incidents still get their match rows recorded, just never a notification.
    expect(db.matches.size).toBe(2)
  })
})

describe("persistSnapshot: recovery fires once at the resolving poll and never again", () => {
  it("sends exactly one recovery on the poll where the incident resolves, and nothing on a later poll even with the outbox purged", async () => {
    const db = emptyDb([dependencyRow({ currentState: "OPERATIONAL" })])
    const store = createFakeStore(db)
    const openOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [incident()],
      }),
      etag: null,
      lastModified: null,
    }
    const resolvedOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incident({
            resolvedAt: new Date(NOW.getTime() + 60_000).toISOString(),
            updatedAt: new Date(NOW.getTime() + 60_000).toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }

    await persistSnapshot(store, openOutcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })
    const resolvePoll = await persistSnapshot(
      store,
      resolvedOutcome,
      baseSource(),
      {
        now: new Date(NOW.getTime() + 60_000),
        defaultRecipients: ["ops@example.com"],
      }
    )
    expect(resolvePoll.notificationsEnqueued).toBe(1)
    expect(db.notifications.at(-1)?.event).toBe("recovery")

    // Clear every sent outbox key, standing in for the 90-day purge of sent
    // rows: with idempotency no longer in the way, only the event
    // derivation's own prior-state check can stop a third poll of the same
    // resolved incident from enqueuing another recovery.
    db.outboxKeys.clear()
    const rePoll = await persistSnapshot(store, resolvedOutcome, baseSource(), {
      now: new Date(NOW.getTime() + 120_000),
      defaultRecipients: ["ops@example.com"],
    })
    expect(rePoll.notificationsEnqueued).toBe(0)
    expect(db.notifications).toHaveLength(2)
  })
})

// -- FIX C: the dedup key (and this fake's dedup emulation) is scoped -----

describe("persistSnapshot: FIX C scoped dedup", () => {
  it("sends two distinct notifications for two scoped installs of the same preset matched by one incident", async () => {
    const db = emptyDb([
      dependencyRow({
        id: "dep-us",
        catalogId: "neon_database",
        scopeId: "us-east-1",
        selector: {
          kind: "statusio_component_container",
          componentId: "c1",
          container: { required: true },
        },
      }),
      dependencyRow({
        id: "dep-eu",
        catalogId: "neon_database",
        scopeId: "eu-west-2",
        selector: {
          kind: "statusio_component_container",
          componentId: "c1",
          container: { required: true },
        },
      }),
    ])
    const store = createFakeStore(db)
    // Both scoped containers are themselves out, so each dependency's own
    // scoped nextState is non-OPERATIONAL and the F1 gate lets both alert. The
    // incident names the parent c1, which both match through.
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: {
          c1: { state: "OUTAGE", updatedAt: null },
          "us-east-1": { state: "OUTAGE", updatedAt: null },
          "eu-west-2": { state: "OUTAGE", updatedAt: null },
        },
        incidents: [incident({ componentIds: ["c1"] })],
      }),
      etag: null,
      lastModified: null,
    }
    const summary = await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })

    expect(summary.notificationsEnqueued).toBe(2)
    expect(db.notifications).toHaveLength(2)
    const scopeIds = db.notifications
      .map((n) => n.scopeId)
      .sort((a, b) => {
        const sa = String(a)
        const sb = String(b)
        return sa < sb ? -1 : sa > sb ? 1 : 0
      })
    expect(scopeIds).toEqual(["eu-west-2", "us-east-1"])
  })
})

// -- FIX #7: a scoped statusio container's persisted state comes from the
// container alone, so a sibling region's outage on the shared parent never
// surfaces as downtime for a region that is actually fine. The parent still
// drives incident matching.

describe("persistSnapshot: scoped statusio container state resolution", () => {
  it("persists the selected container's OPERATIONAL state even when the parent aggregates a sibling region's outage, and still matches the parent-named incident", async () => {
    const db = emptyDb([
      dependencyRow({
        id: "dep-us",
        catalogId: "neon_database",
        scopeId: "us-east-1",
        currentState: "OPERATIONAL",
        selector: {
          kind: "statusio_component_container",
          componentId: "c1",
          container: { required: true },
        },
      }),
    ])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: {
          // The parent aggregates the worst region: another region is out.
          c1: { state: "OUTAGE", updatedAt: null },
          "us-east-1": { state: "OPERATIONAL", updatedAt: null },
        },
        incidents: [incident({ componentIds: ["c1"] })],
      }),
      etag: null,
      lastModified: null,
    }
    await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })

    // State comes from the container alone: the sibling region's OUTAGE on
    // the parent never surfaces here.
    expect(db.installed[0]?.currentState).toBe("OPERATIONAL")
    // The parent-named incident still associates for matching.
    expect(db.matches.size).toBe(1)
  })

  it("persists the selected container's own DEGRADED state", async () => {
    const db = emptyDb([
      dependencyRow({
        id: "dep-us",
        catalogId: "neon_database",
        scopeId: "us-east-1",
        currentState: "OPERATIONAL",
        selector: {
          kind: "statusio_component_container",
          componentId: "c1",
          container: { required: true },
        },
      }),
    ])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: {
          c1: { state: "OUTAGE", updatedAt: null },
          "us-east-1": { state: "DEGRADED", updatedAt: null },
        },
      }),
      etag: null,
      lastModified: null,
    }
    await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })

    expect(db.installed[0]?.currentState).toBe("DEGRADED")
  })
})

// -- FIX F: canonicalUrl is sanitized before it reaches storage or a payload

describe("persistSnapshot: FIX F canonicalUrl sanitization", () => {
  it("stores and forwards the status page fallback when the provider's canonicalUrl is a javascript: URL", async () => {
    const db = emptyDb([dependencyRow()])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [incident({ canonicalUrl: "javascript:alert(1)" })],
      }),
      etag: null,
      lastModified: null,
    }
    await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })

    const internalId = db.incidentsBySourceExternal.get("vercel:inc-1")!
    expect(db.upsertedCanonicalUrls.get(internalId)).toBe(
      "https://www.vercel-status.com/"
    )
    expect(db.notifications[0]?.canonicalUrl).toBe(
      "https://www.vercel-status.com/"
    )
  })

  it("falls back to the status page for an offsite https canonicalUrl", async () => {
    const db = emptyDb([dependencyRow()])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [
          incident({ canonicalUrl: "https://attacker.example/incidents/1" }),
        ],
      }),
      etag: null,
      lastModified: null,
    }
    await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })

    const internalId = db.incidentsBySourceExternal.get("vercel:inc-1")!
    expect(db.upsertedCanonicalUrls.get(internalId)).toBe(
      "https://www.vercel-status.com/"
    )
    expect(db.notifications[0]?.canonicalUrl).toBe(
      "https://www.vercel-status.com/"
    )
  })

  it("preserves an allowed-host canonicalUrl unchanged", async () => {
    const db = emptyDb([dependencyRow()])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [
          incident({
            canonicalUrl: "https://www.vercel-status.com/incidents/inc-1",
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }
    await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })

    const internalId = db.incidentsBySourceExternal.get("vercel:inc-1")!
    expect(db.upsertedCanonicalUrls.get(internalId)).toBe(
      "https://www.vercel-status.com/incidents/inc-1"
    )
    expect(db.notifications[0]?.canonicalUrl).toBe(
      "https://www.vercel-status.com/incidents/inc-1"
    )
  })
})

// -- FIX E: a dependency on a disabled preset is never recomputed by a poll

describe("persistSnapshot: FIX E disabled-preset dependencies are skipped", () => {
  it("leaves a disabled preset's UNKNOWN dependency and its open UNKNOWN interval untouched across a subsequent poll", async () => {
    // catalog-sync's flipDependenciesToUnknown already set this dependency to
    // UNKNOWN with an open UNKNOWN interval when its preset drifted and got
    // disabled. loadInstalledDependencies's real query now filters out
    // dependencies whose dependency_catalog.enabled is false (persist.ts's
    // createSqlPersistStore), so it is never returned here, and this poll of
    // the source's OTHER dependencies must not touch it.
    const db = emptyDb([])
    db.intervals.push({
      dependencyId: "dep-disabled",
      state: "UNKNOWN",
      startedAt: NOW,
      endedAt: null,
    })
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
      }),
      etag: null,
      lastModified: null,
    }
    await persistSnapshot(store, outcome, baseSource(), {
      now: new Date(NOW.getTime() + 60_000),
      defaultRecipients: [],
    })

    const interval = db.intervals.find((i) => i.dependencyId === "dep-disabled")
    expect(interval).toMatchObject({ state: "UNKNOWN", endedAt: null })
  })
})

// -- incidentio_compat: resolved incidents become unmapped (inference only
// while active). Recovery depends on the durable match row recorded while
// the incident carried a components scope.

describe("persistSnapshot: incidentio_compat resolved-incident recovery fallback", () => {
  it("fires incident on the active poll, recovery when scope becomes unmapped and the incident resolves, then nothing on an unchanged repeat", async () => {
    const db = emptyDb([dependencyRow({ currentState: "OPERATIONAL" })])
    const store = createFakeStore(db)
    const source = baseSource({ adapter: "incidentio_compat" })

    const activeOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [incident({ componentIds: ["c1"] })],
      }),
      etag: null,
      lastModified: null,
    }
    const resolvedOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incident({
            scope: unmappedIncidentScope(),
            resolvedAt: new Date(NOW.getTime() + 60_000).toISOString(),
            updatedAt: new Date(NOW.getTime() + 60_000).toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }

    const poll1 = await persistSnapshot(store, activeOutcome, source, {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })
    const poll2 = await persistSnapshot(store, resolvedOutcome, source, {
      now: new Date(NOW.getTime() + 60_000),
      defaultRecipients: ["ops@example.com"],
    })
    const poll3 = await persistSnapshot(store, resolvedOutcome, source, {
      now: new Date(NOW.getTime() + 120_000),
      defaultRecipients: ["ops@example.com"],
    })

    expect(poll1.notificationsEnqueued).toBe(1)
    expect(poll2.notificationsEnqueued).toBe(1)
    expect(poll3.notificationsEnqueued).toBe(0)
    expect(db.notifications.map((n) => n.event)).toEqual([
      "incident",
      "recovery",
    ])
    expect(db.installed[0]?.currentState).toBe("OPERATIONAL")
    expect(db.matches.size).toBe(1)
  })

  it("enqueues nothing for a resolved unmapped incident with no prior match row", async () => {
    const db = emptyDb([dependencyRow({ currentState: "OPERATIONAL" })])
    const store = createFakeStore(db)
    const source = baseSource({ adapter: "incidentio_compat" })
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incident({
            scope: unmappedIncidentScope(),
            resolvedAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }
    const summary = await persistSnapshot(store, outcome, source, {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })

    expect(summary.notificationsEnqueued).toBe(0)
    expect(db.notifications).toHaveLength(0)
    expect(db.matches.size).toBe(0)
  })
})

// -- Reopen lifecycle: a provider incident under one external id can go
// active, resolve, reopen, and resolve again. Each of the two cycles gets
// its own incident alert and its own recovery alert, with keys distinct
// from the other cycle's so the outbox's ON CONFLICT DO NOTHING never
// drops the second cycle's alerts as duplicates of the first's.

describe("persistSnapshot: reopen lifecycle under one external id", () => {
  it("fires incident, recovery, a distinct second incident on reopen, nothing on repeat, a distinct second recovery, then nothing again", async () => {
    const db = emptyDb([dependencyRow({ currentState: "OPERATIONAL" })])
    const store = createFakeStore(db)
    const source = baseSource()

    const t0 = NOW
    const t1 = new Date(NOW.getTime() + 60_000)
    const t2 = new Date(NOW.getTime() + 120_000)
    const t3 = new Date(NOW.getTime() + 180_000)
    const t4 = new Date(NOW.getTime() + 240_000)
    const t5 = new Date(NOW.getTime() + 300_000)

    const activeOutcome = (updatedAt: Date): PollOutcome => ({
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [
          incident({ resolvedAt: null, updatedAt: updatedAt.toISOString() }),
        ],
      }),
      etag: null,
      lastModified: null,
    })
    const resolvedOutcome = (resolvedAt: Date): PollOutcome => ({
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incident({
            resolvedAt: resolvedAt.toISOString(),
            updatedAt: resolvedAt.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    })

    // Poll 1: active, first incident alert.
    const poll1 = await persistSnapshot(store, activeOutcome(t0), source, {
      now: t0,
      defaultRecipients: ["ops@example.com"],
    })
    // Poll 2: resolved, first recovery alert.
    const poll2 = await persistSnapshot(store, resolvedOutcome(t1), source, {
      now: t1,
      defaultRecipients: ["ops@example.com"],
    })
    // Poll 3: reopened under the same external id, second incident alert.
    const poll3 = await persistSnapshot(store, activeOutcome(t2), source, {
      now: t2,
      defaultRecipients: ["ops@example.com"],
    })
    // Poll 4: unchanged active, nothing.
    const poll4 = await persistSnapshot(store, activeOutcome(t2), source, {
      now: t3,
      defaultRecipients: ["ops@example.com"],
    })
    // Poll 5: resolved again, second recovery alert.
    const poll5 = await persistSnapshot(store, resolvedOutcome(t4), source, {
      now: t4,
      defaultRecipients: ["ops@example.com"],
    })
    // Poll 6: unchanged resolved, nothing.
    const poll6 = await persistSnapshot(store, resolvedOutcome(t4), source, {
      now: t5,
      defaultRecipients: ["ops@example.com"],
    })

    expect(poll1.notificationsEnqueued).toBe(1)
    expect(poll2.notificationsEnqueued).toBe(1)
    expect(poll3.notificationsEnqueued).toBe(1)
    expect(poll4.notificationsEnqueued).toBe(0)
    expect(poll5.notificationsEnqueued).toBe(1)
    expect(poll6.notificationsEnqueued).toBe(0)

    expect(db.notifications.map((n) => n.event)).toEqual([
      "incident",
      "recovery",
      "incident",
      "recovery",
    ])

    // Each cycle's incident alert carries a key distinct from the other
    // cycle's incident alert, and likewise for the two recovery alerts, so
    // neither of the second cycle's alerts collides with the first's.
    const [
      firstIncidentKey,
      firstRecoveryKey,
      secondIncidentKey,
      secondRecoveryKey,
    ] = db.notifications.map((n) => n.incidentExternalId)
    expect(firstIncidentKey).not.toBe(secondIncidentKey)
    expect(firstRecoveryKey).not.toBe(secondRecoveryKey)
    // The first incident keeps the bare external id, unchanged from before
    // reopen handling existed.
    expect(firstIncidentKey).toBe("inc-1")

    expect(db.installed[0]?.currentState).toBe("OPERATIONAL")
    // One provider incident row and one match row throughout: the same
    // external id and the same dependency across every poll.
    expect(db.incidentsBySourceExternal.size).toBe(1)
    expect(db.matches.size).toBe(1)
  })

  it("enqueues nothing on a second and third poll of the same already-resolved incident, even with the recovery key's occurrence discriminator", async () => {
    const db = emptyDb([dependencyRow({ currentState: "OPERATIONAL" })])
    const store = createFakeStore(db)
    const resolvedAt = new Date(NOW.getTime() + 60_000)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incident({
            resolvedAt: resolvedAt.toISOString(),
            updatedAt: resolvedAt.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }

    const poll1 = await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })
    const poll2 = await persistSnapshot(store, outcome, baseSource(), {
      now: new Date(NOW.getTime() + 60_000),
      defaultRecipients: ["ops@example.com"],
    })
    const poll3 = await persistSnapshot(store, outcome, baseSource(), {
      now: new Date(NOW.getTime() + 120_000),
      defaultRecipients: ["ops@example.com"],
    })

    expect(poll1.notificationsEnqueued).toBe(0)
    expect(poll2.notificationsEnqueued).toBe(0)
    expect(poll3.notificationsEnqueued).toBe(0)
    expect(db.notifications).toHaveLength(0)
  })
})

// -- Reopen first matched on the reopening poll: a dependency that never
// matched during the incident's first active cycle, because the incident
// then named different components, first intersects it only once the
// incident has reopened active under the same external id. isNewMatch is
// true and the incident was stored resolved as of the prior poll, so this
// is still a reopen transition and must fire "incident" with an
// occurrence-discriminated key rather than the bare external id.

describe("persistSnapshot: reopen first matched on the reopening poll", () => {
  it("fires incident with a discriminated key when the dependency first matches a reopened active incident", async () => {
    const db = emptyDb([dependencyRow({ currentState: "OPERATIONAL" })])
    const store = createFakeStore(db)
    const source = baseSource()
    const t0 = NOW
    const t1 = new Date(NOW.getTime() + 60_000)

    // Poll 1: the incident is already resolved and names a component this
    // dependency's selector does not cover, so no match row is recorded and
    // nothing is enqueued, but the incident row is stored resolved.
    const resolvedElsewhere: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incident({
            componentIds: ["other"],
            resolvedAt: t0.toISOString(),
            updatedAt: t0.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }
    // Poll 2: the same external id reopens active and now names c1, so this
    // dependency intersects it for the first time (isNewMatch true) against
    // an incident stored resolved as of the prior poll.
    const reopenedHere: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [
          incident({
            componentIds: ["c1"],
            resolvedAt: null,
            updatedAt: t1.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }

    const poll1 = await persistSnapshot(store, resolvedElsewhere, source, {
      now: t0,
      defaultRecipients: ["ops@example.com"],
    })
    const poll2 = await persistSnapshot(store, reopenedHere, source, {
      now: t1,
      defaultRecipients: ["ops@example.com"],
    })

    expect(poll1.notificationsEnqueued).toBe(0)
    expect(poll2.notificationsEnqueued).toBe(1)
    expect(db.notifications).toHaveLength(1)
    expect(db.notifications[0]?.event).toBe("incident")
    // The reopen alert carries the occurrence-discriminated key, not the
    // bare external id, so it can never dedupe against a first-cycle
    // incident alert for the same external id.
    expect(db.notifications[0]?.incidentExternalId).toBe(
      `inc-1#${t0.getTime()}`
    )
    expect(db.installed[0]?.currentState).toBe("OUTAGE")
    // One match row: the first-ever match, created on the reopening poll.
    expect(db.matches.size).toBe(1)
  })

  it("stays silent when a dependency first matches an already-resolved historical incident", async () => {
    const db = emptyDb([dependencyRow({ currentState: "OPERATIONAL" })])
    const store = createFakeStore(db)
    const source = baseSource()
    const t0 = NOW
    const t1 = new Date(NOW.getTime() + 60_000)

    // Poll 1: resolved incident names a component the dependency does not
    // cover. No match, nothing enqueued, incident stored resolved.
    const resolvedElsewhere: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incident({
            componentIds: ["other"],
            resolvedAt: t0.toISOString(),
            updatedAt: t0.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }
    // Poll 2: the still-resolved incident now also names c1, so the
    // dependency matches for the first time (isNewMatch true) but against an
    // incident that stayed resolved. That is backfill, not a transition.
    const resolvedNowNamingC1: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incident({
            componentIds: ["c1"],
            resolvedAt: t0.toISOString(),
            updatedAt: t1.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }

    const poll1 = await persistSnapshot(store, resolvedElsewhere, source, {
      now: t0,
      defaultRecipients: ["ops@example.com"],
    })
    const poll2 = await persistSnapshot(store, resolvedNowNamingC1, source, {
      now: t1,
      defaultRecipients: ["ops@example.com"],
    })

    expect(poll1.notificationsEnqueued).toBe(0)
    expect(poll2.notificationsEnqueued).toBe(0)
    expect(db.notifications).toHaveLength(0)
    // The match row is still recorded on the second poll: only the
    // notification is suppressed.
    expect(db.matches.size).toBe(1)
  })
})

// -- The outbox insert rolls back with the rest of the poll transaction ---
//
// enqueueNotification must run on the same transaction as the state,
// interval, and match writes, so a later failure in that same transaction
// (e.g. an interval-order constraint violation) rolls the outbox insert
// back with everything else instead of leaving an orphaned row that the
// delivery cron would send for a state change the dashboard never shows.

describe("persistSnapshot: outbox insert shares the poll transaction's rollback", () => {
  it("leaves no outbox row, and no state or match write either, when a later statement in the same transaction throws after enqueueNotification ran", async () => {
    const db = emptyDb([dependencyRow()])
    const executor: PersistExecutor = {
      ...createExecutor(db),
      // Stands in for a later write in the same poll transaction failing
      // (e.g. dependency_state_intervals' ended_at >= started_at check).
      // This runs after every dependency's applyDependencyState, match, and
      // enqueueNotification call in persistSnapshot's loop, so by the time
      // it throws the fake db already recorded the outbox row.
      async updateSourceHealthSuccess(sourceId, patch) {
        await createExecutor(db).updateSourceHealthSuccess(sourceId, patch)
        throw new Error("simulated interval-order constraint violation")
      },
    }
    const store = createFakeStore(db, executor)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [incident()],
      }),
      etag: '"v3"',
      lastModified: null,
    }

    await expect(
      persistSnapshot(store, outcome, baseSource(), {
        now: NOW,
        defaultRecipients: ["ops@example.com"],
      })
    ).rejects.toThrow("simulated interval-order constraint violation")

    // The outbox row enqueueNotification recorded mid-transaction is gone:
    // it never survives past the throw that follows it in the same
    // transaction.
    expect(db.notifications).toHaveLength(0)
    expect(db.outboxKeys.size).toBe(0)
    // Everything else the same transaction wrote rolls back with it too,
    // since it's all one transaction, not just the outbox row.
    expect(db.installed[0]?.currentState).toBe("OPERATIONAL")
    expect(db.matches.size).toBe(0)
    expect(db.sourceHealth).toHaveLength(0)
  })
})

// -- Source-wide match scope: active source matches every installed dep.
// Resolved source keeps existing matches only (no install-time broaden).
// Unmapped never creates a new match.

describe("persistSnapshot: source and unmapped match scope", () => {
  it("matches every installed dependency and fires incident for an active source-wide incident", async () => {
    const db = emptyDb([
      dependencyRow({
        id: "dep-1",
        selector: {
          kind: "component_ids",
          aggregation: "worst_of",
          ids: ["c1"],
        },
      }),
      dependencyRow({
        id: "dep-2",
        catalogId: "vercel_edge",
        selector: {
          kind: "component_ids",
          aggregation: "worst_of",
          ids: ["c2"],
        },
      }),
    ])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: {
          c1: { state: "OPERATIONAL", updatedAt: null },
          c2: { state: "OPERATIONAL", updatedAt: null },
        },
        incidents: [incident({ scope: sourceIncidentScope() })],
      }),
      etag: null,
      lastModified: null,
    }
    const summary = await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })

    expect(summary.notificationsEnqueued).toBe(2)
    expect(db.matches.size).toBe(2)
    expect(db.notifications.map((n) => n.event)).toEqual([
      "incident",
      "incident",
    ])
  })

  it("fires recovery through the existing-match fallback when a source-wide incident later resolves", async () => {
    const db = emptyDb([
      dependencyRow({
        id: "dep-1",
        selector: {
          kind: "component_ids",
          aggregation: "worst_of",
          ids: ["c1"],
        },
      }),
    ])
    const store = createFakeStore(db)
    const activeOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [incident({ scope: sourceIncidentScope() })],
      }),
      etag: null,
      lastModified: null,
    }
    const resolvedOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incident({
            scope: sourceIncidentScope(),
            resolvedAt: new Date(NOW.getTime() + 60_000).toISOString(),
            updatedAt: new Date(NOW.getTime() + 60_000).toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }

    const poll1 = await persistSnapshot(store, activeOutcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })
    const poll2 = await persistSnapshot(store, resolvedOutcome, baseSource(), {
      now: new Date(NOW.getTime() + 60_000),
      defaultRecipients: ["ops@example.com"],
    })

    expect(poll1.notificationsEnqueued).toBe(1)
    expect(poll2.notificationsEnqueued).toBe(1)
    expect(db.notifications.map((n) => n.event)).toEqual([
      "incident",
      "recovery",
    ])
    expect(db.matches.size).toBe(1)
  })

  it("keeps existing-match only (no match-all) for a historical resolved source-wide incident on install", async () => {
    const db = emptyDb([
      dependencyRow({
        id: "dep-1",
        selector: {
          kind: "component_ids",
          aggregation: "worst_of",
          ids: ["c1"],
        },
      }),
    ])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incident({
            scope: sourceIncidentScope(),
            resolvedAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }
    const summary = await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })

    expect(summary.notificationsEnqueued).toBe(0)
    expect(db.matches.size).toBe(0)
  })

  it("does not match-all for an unmapped active incident", async () => {
    const db = emptyDb([
      dependencyRow({
        id: "dep-1",
        selector: {
          kind: "component_ids",
          aggregation: "worst_of",
          ids: ["c1"],
        },
      }),
    ])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [incident({ scope: unmappedIncidentScope() })],
      }),
      etag: null,
      lastModified: null,
    }
    const summary = await persistSnapshot(
      store,
      outcome,
      baseSource({ adapter: "incidentio_compat" }),
      { now: NOW, defaultRecipients: ["ops@example.com"] }
    )

    expect(summary.notificationsEnqueued).toBe(0)
    expect(db.matches.size).toBe(0)
  })
})

// -- incident_only fidelity: recovery is eligible at UNKNOWN (or OPERATIONAL).
// Source-wide scope still drives matching. Scope no longer exempts recovery.

describe("persistSnapshot: incident_only recovery under UNKNOWN state", () => {
  it("fires incident then recovery for a source-wide incident_only feed even though state stays UNKNOWN", async () => {
    const db = emptyDb([
      dependencyRow({
        id: "dep-1",
        selector: {
          kind: "component_ids",
          aggregation: "worst_of",
          ids: ["incident-feed"],
        },
        fidelity: "incident_only",
      }),
    ])
    const store = createFakeStore(db)
    const source = baseSource({
      adapter: "incident_feed",
      provider: "OpenRouter",
    })

    const activeOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        componentsComplete: true,
        incidentsComplete: false,
        components: {},
        incidents: [incident({ scope: sourceIncidentScope() })],
      }),
      etag: null,
      lastModified: null,
    }
    const resolvedOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        componentsComplete: true,
        incidentsComplete: false,
        components: {},
        incidents: [
          incident({
            scope: sourceIncidentScope(),
            state: "resolved",
            resolvedAt: new Date(NOW.getTime() + 60_000).toISOString(),
            updatedAt: new Date(NOW.getTime() + 60_000).toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }

    const poll1 = await persistSnapshot(store, activeOutcome, source, {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })
    const poll2 = await persistSnapshot(store, resolvedOutcome, source, {
      now: new Date(NOW.getTime() + 60_000),
      defaultRecipients: ["ops@example.com"],
    })

    expect(poll1.notificationsEnqueued).toBe(1)
    expect(poll2.notificationsEnqueued).toBe(1)
    expect(db.notifications.map((n) => n.event)).toEqual([
      "incident",
      "recovery",
    ])
    expect(db.installed[0]?.currentState).toBe("UNKNOWN")
    expect(db.matches.size).toBe(1)
  })

  it("does not fire recovery for an unmapped incident under UNKNOWN with no prior match", async () => {
    const db = emptyDb([
      dependencyRow({
        id: "dep-1",
        selector: {
          kind: "component_ids",
          aggregation: "worst_of",
          ids: ["incident-feed"],
        },
        fidelity: "incident_only",
      }),
    ])
    const store = createFakeStore(db)
    const source = baseSource({ adapter: "incidentio_compat" })

    const activeOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        componentsComplete: true,
        incidentsComplete: false,
        components: {},
        incidents: [incident({ scope: unmappedIncidentScope() })],
      }),
      etag: null,
      lastModified: null,
    }
    const resolvedOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        componentsComplete: true,
        incidentsComplete: false,
        components: {},
        incidents: [
          incident({
            scope: unmappedIncidentScope(),
            state: "resolved",
            resolvedAt: new Date(NOW.getTime() + 60_000).toISOString(),
            updatedAt: new Date(NOW.getTime() + 60_000).toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }

    await persistSnapshot(store, activeOutcome, source, {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })
    await persistSnapshot(store, resolvedOutcome, source, {
      now: new Date(NOW.getTime() + 60_000),
      defaultRecipients: ["ops@example.com"],
    })

    expect(db.notifications).toHaveLength(0)
    expect(db.matches.size).toBe(0)
  })
})

// -- FIX F-A3: a matched open incident that vanishes from a complete snapshot
// is closed (resolved_at set) and fires recovery, but only when the snapshot
// authoritatively enumerates every open incident (incidentsComplete).

describe("persistSnapshot: FIX F-A3 completeness-gated closure of disappeared incidents", () => {
  it("closes a matched open incident absent from a complete snapshot and fires recovery", async () => {
    const db = emptyDb([
      dependencyRow({ id: "dep-1", currentState: "OPERATIONAL" }),
    ])
    const store = createFakeStore(db)
    const openOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [incident()],
      }),
      etag: null,
      lastModified: null,
    }
    // The incident vanished entirely from the next complete snapshot.
    const vanishedOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        incidentsComplete: true,
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [],
      }),
      etag: null,
      lastModified: null,
    }

    await persistSnapshot(store, openOutcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })
    const closePoll = await persistSnapshot(
      store,
      vanishedOutcome,
      baseSource(),
      {
        now: new Date(NOW.getTime() + 60_000),
        defaultRecipients: ["ops@example.com"],
      }
    )

    expect(closePoll.notificationsEnqueued).toBe(1)
    expect(db.notifications.map((n) => n.event)).toEqual([
      "incident",
      "recovery",
    ])
    // The incident is now stored resolved: closure set its resolved_at.
    expect(db.incidentResolvedAt.get("vercel:inc-1")).toBeInstanceOf(Date)
    expect(db.installed[0]?.currentState).toBe("OPERATIONAL")
  })

  it("fires recovery only once: a still-closed incident on a later complete poll enqueues nothing more", async () => {
    const db = emptyDb([
      dependencyRow({ id: "dep-1", currentState: "OPERATIONAL" }),
    ])
    const store = createFakeStore(db)
    const openOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [incident()],
      }),
      etag: null,
      lastModified: null,
    }
    const vanishedOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        incidentsComplete: true,
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [],
      }),
      etag: null,
      lastModified: null,
    }

    await persistSnapshot(store, openOutcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })
    await persistSnapshot(store, vanishedOutcome, baseSource(), {
      now: new Date(NOW.getTime() + 60_000),
      defaultRecipients: ["ops@example.com"],
    })
    const rePoll = await persistSnapshot(store, vanishedOutcome, baseSource(), {
      now: new Date(NOW.getTime() + 120_000),
      defaultRecipients: ["ops@example.com"],
    })

    // Already closed, no longer open, so no second recovery.
    expect(rePoll.notificationsEnqueued).toBe(0)
    expect(db.notifications).toHaveLength(2)
  })

  it("never closes a disappeared incident when the snapshot is not incident-complete", async () => {
    const db = emptyDb([
      dependencyRow({ id: "dep-1", currentState: "OPERATIONAL" }),
    ])
    const store = createFakeStore(db)
    const openOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [incident()],
      }),
      etag: null,
      lastModified: null,
    }
    // An incomplete snapshot (a rolling-window feed) that happens to omit the
    // still-open incident must not be read as resolution.
    const incompleteOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        incidentsComplete: false,
        componentsComplete: false,
        components: {},
        incidents: [],
      }),
      etag: null,
      lastModified: null,
    }

    await persistSnapshot(store, openOutcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })
    const poll2 = await persistSnapshot(
      store,
      incompleteOutcome,
      baseSource(),
      {
        now: new Date(NOW.getTime() + 60_000),
        defaultRecipients: ["ops@example.com"],
      }
    )

    expect(poll2.notificationsEnqueued).toBe(0)
    // The incident stays open: no recovery, resolved_at still null.
    expect(db.incidentResolvedAt.get("vercel:inc-1")).toBeNull()
    expect(db.notifications.map((n) => n.event)).toEqual(["incident"])
  })
})

// -- FIX F-A4: a reopen under the same external id re-anchors started_at, so
// overlap offsetSeconds and the detail "Started" track the current outage.

describe("persistSnapshot: FIX F-A4 reopen re-anchors started_at", () => {
  it("rewrites the stored started_at to the reopen's started time", async () => {
    const db = emptyDb([dependencyRow({ currentState: "OPERATIONAL" })])
    const store = createFakeStore(db)
    const t0 = NOW
    const t1 = new Date(NOW.getTime() + 60_000)
    const t2 = new Date(NOW.getTime() + 120_000)

    const firstActive: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [
          incident({
            startedAt: t0.toISOString(),
            updatedAt: t0.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }
    const resolved: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incident({
            startedAt: t0.toISOString(),
            resolvedAt: t1.toISOString(),
            updatedAt: t1.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }
    // Reopened under the same external id with a new provider started time.
    const reopened: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [
          incident({
            startedAt: t2.toISOString(),
            resolvedAt: null,
            updatedAt: t2.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }

    await persistSnapshot(store, firstActive, baseSource(), {
      now: t0,
      defaultRecipients: ["ops@example.com"],
    })
    await persistSnapshot(store, resolved, baseSource(), {
      now: t1,
      defaultRecipients: ["ops@example.com"],
    })
    await persistSnapshot(store, reopened, baseSource(), {
      now: t2,
      defaultRecipients: ["ops@example.com"],
    })

    const internalId = db.incidentsBySourceExternal.get("vercel:inc-1")!
    // Re-anchored to the reopen's started time, not the first outage's.
    expect(db.incidentMeta.get(internalId)?.startedAt).toEqual(t2)
  })
})

// -- FIX F-A5: last_successful_poll_at advances only on a real snapshot, not
// on a stale-failure flip to UNKNOWN.

describe("persistSnapshot: FIX F-A5 last_successful_poll_at only advances on success", () => {
  it("advances on a snapshot poll and holds across a later stale-failure UNKNOWN flip", async () => {
    const db = emptyDb([
      dependencyRow({ id: "dep-1", currentState: "OPERATIONAL" }),
    ])
    const store = createFakeStore(db)
    const snapshotOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [],
      }),
      etag: null,
      lastModified: null,
    }
    await persistSnapshot(store, snapshotOutcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })
    expect(db.lastSuccessfulPollAt.get("dep-1")).toEqual(NOW)

    // A later stale failure flips the dependency to UNKNOWN.
    const failureAt = new Date(NOW.getTime() + 700_000)
    const failureOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "failure",
      error: new Error("boom"),
      retryAfterMs: null,
    }
    const summary = await persistSnapshot(
      store,
      failureOutcome,
      baseSource({ staleAfterSeconds: 600, lastSuccessAt: NOW }),
      { now: failureAt, defaultRecipients: ["ops@example.com"] }
    )

    expect(summary.flippedToUnknown).toBe(1)
    expect(db.installed[0]?.currentState).toBe("UNKNOWN")
    // The success timestamp still points at the real snapshot, not the failure.
    expect(db.lastSuccessfulPollAt.get("dep-1")).toEqual(NOW)
  })
})

// -- F1: a scoped install matched only through its parent aggregate id must
// not receive a spurious "incident" alert when its own scope resolves
// OPERATIONAL. The match row is still recorded for correlation.

describe("persistSnapshot: F1 scoped install spurious-incident suppression", () => {
  it("records the match but suppresses the incident alert when only a sibling scope is affected", async () => {
    const db = emptyDb([
      dependencyRow({
        id: "dep-us",
        catalogId: "neon_database",
        scopeId: "us-east-1",
        currentState: "OPERATIONAL",
        selector: {
          kind: "statusio_component_container",
          componentId: "c1",
          container: { required: true },
        },
      }),
    ])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: {
          // The parent aggregates a sibling region's outage, the scoped
          // container itself is fine, and the incident names the parent.
          c1: { state: "OUTAGE", updatedAt: null },
          "us-east-1": { state: "OPERATIONAL", updatedAt: null },
        },
        incidents: [incident({ componentIds: ["c1"] })],
      }),
      etag: null,
      lastModified: null,
    }
    const summary = await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })

    // No incident alert: the incident did not degrade this dependency's scope.
    expect(summary.notificationsEnqueued).toBe(0)
    expect(db.notifications).toHaveLength(0)
    // The match row is still recorded, for correlation.
    expect(db.matches.size).toBe(1)
    expect(db.installed[0]?.currentState).toBe("OPERATIONAL")
  })

  it("still fires the incident alert for a scoped install when its own scope is the one affected", async () => {
    const db = emptyDb([
      dependencyRow({
        id: "dep-us",
        catalogId: "neon_database",
        scopeId: "us-east-1",
        currentState: "OPERATIONAL",
        selector: {
          kind: "statusio_component_container",
          componentId: "c1",
          container: { required: true },
        },
      }),
    ])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: {
          c1: { state: "OUTAGE", updatedAt: null },
          "us-east-1": { state: "OUTAGE", updatedAt: null },
        },
        incidents: [incident({ componentIds: ["c1"] })],
      }),
      etag: null,
      lastModified: null,
    }
    const summary = await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })

    expect(summary.notificationsEnqueued).toBe(1)
    expect(db.notifications[0]?.event).toBe("incident")
    expect(db.installed[0]?.currentState).toBe("OUTAGE")
  })
})

// -- F2: recovery is gated on the dependency's overall resolved state, not a
// single incident. A dependency matched to two concurrent incidents does not
// send a premature "recovered" alert when the first resolves while the second
// still degrades it. Its one recovery fires only when it truly returns to
// OPERATIONAL.

describe("persistSnapshot: F2 recovery gated on overall state", () => {
  it("suppresses recovery for one resolved incident while another matching incident still degrades the dependency", async () => {
    const db = emptyDb([
      dependencyRow({
        id: "dep-1",
        currentState: "OPERATIONAL",
        selector: {
          kind: "component_ids",
          aggregation: "worst_of",
          ids: ["c1"],
        },
      }),
    ])
    const store = createFakeStore(db)
    const source = baseSource()
    const t0 = NOW
    const t1 = new Date(NOW.getTime() + 60_000)
    const t2 = new Date(NOW.getTime() + 120_000)

    const incE = (resolvedAt: string | null, updatedAt: string) =>
      incident({
        externalId: "inc-E",
        componentIds: ["c1"],
        resolvedAt,
        updatedAt,
      })
    const incF = (resolvedAt: string | null, updatedAt: string) =>
      incident({
        externalId: "inc-F",
        componentIds: ["c1"],
        resolvedAt,
        updatedAt,
      })

    // Poll 1: both incidents active, dependency OUTAGE, one incident alert each.
    const bothActive: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [incE(null, t0.toISOString()), incF(null, t0.toISOString())],
      }),
      etag: null,
      lastModified: null,
    }
    // Poll 2: E resolves, F still active, dependency still OUTAGE from F.
    const eResolved: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [
          incE(t1.toISOString(), t1.toISOString()),
          incF(null, t1.toISOString()),
        ],
      }),
      etag: null,
      lastModified: null,
    }
    // Poll 3: F resolves too, dependency finally OPERATIONAL.
    const bothResolved: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incE(t1.toISOString(), t1.toISOString()),
          incF(t2.toISOString(), t2.toISOString()),
        ],
      }),
      etag: null,
      lastModified: null,
    }

    const poll1 = await persistSnapshot(store, bothActive, source, {
      now: t0,
      defaultRecipients: ["ops@example.com"],
    })
    const poll2 = await persistSnapshot(store, eResolved, source, {
      now: t1,
      defaultRecipients: ["ops@example.com"],
    })
    const poll3 = await persistSnapshot(store, bothResolved, source, {
      now: t2,
      defaultRecipients: ["ops@example.com"],
    })

    expect(poll1.notificationsEnqueued).toBe(2)
    // E's recovery is suppressed: the dependency is still OUTAGE from F.
    expect(poll2.notificationsEnqueued).toBe(0)
    // Only when F resolves and the dependency is OPERATIONAL does one recovery fire.
    expect(poll3.notificationsEnqueued).toBe(1)
    expect(db.notifications.map((n) => n.event)).toEqual([
      "incident",
      "incident",
      "recovery",
    ])
    expect(db.installed[0]?.currentState).toBe("OPERATIONAL")
  })
})

// -- F3: closeIncident resolves at greatest(now, started_at), so a
// stored-open incident whose provider started_at is ahead of server now never
// lands a resolved_at before its own started_at and never trips the
// provider_incidents_resolution_order check.

describe("persistSnapshot: F3 closeIncident greatest(now, started_at) guard", () => {
  it("resolves a disappeared incident at its own started_at when that is ahead of the close-time now", async () => {
    const db = emptyDb([
      dependencyRow({ id: "dep-1", currentState: "OPERATIONAL" }),
    ])
    const store = createFakeStore(db)
    // The incident's provider started_at is well ahead of both poll times.
    const futureStart = new Date(NOW.getTime() + 300_000)
    const openOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [
          incident({
            startedAt: futureStart.toISOString(),
            updatedAt: NOW.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }
    // The incident vanishes from the next complete snapshot and is closed.
    const closeAt = new Date(NOW.getTime() + 60_000)
    const vanishedOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        incidentsComplete: true,
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [],
      }),
      etag: null,
      lastModified: null,
    }

    await persistSnapshot(store, openOutcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })
    await persistSnapshot(store, vanishedOutcome, baseSource(), {
      now: closeAt,
      defaultRecipients: ["ops@example.com"],
    })

    // resolved_at is clamped up to started_at, never the earlier close-time now.
    expect(db.incidentResolvedAt.get("vercel:inc-1")).toEqual(futureStart)
    expect(db.incidentResolvedAt.get("vercel:inc-1")).not.toEqual(closeAt)
  })
})

// -- Provider-published resolved_at can precede its own started_at (observed
// live: Cloudflare incident 1nxybwbw5cdk resolved 2h48m before it started).
// persistSnapshot clamps resolution to the start on ingestion, or the
// provider_incidents_resolution_order check aborts the whole poll.

describe("persistSnapshot: resolved-before-started clamp on ingestion", () => {
  it("clamps a provider resolved_at that precedes started_at up to started_at", async () => {
    const db = emptyDb([
      dependencyRow({ id: "dep-1", currentState: "OPERATIONAL" }),
    ])
    const store = createFakeStore(db)
    const startedAt = new Date(NOW.getTime() - 3_600_000)
    const resolvedBeforeStart = new Date(startedAt.getTime() - 10_000_000)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incident({
            state: "resolved",
            startedAt: startedAt.toISOString(),
            resolvedAt: resolvedBeforeStart.toISOString(),
            updatedAt: NOW.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }

    await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })

    expect(db.incidentResolvedAt.get("vercel:inc-1")).toEqual(startedAt)
  })

  it("keeps a well-ordered resolved_at unchanged", async () => {
    const db = emptyDb([
      dependencyRow({ id: "dep-1", currentState: "OPERATIONAL" }),
    ])
    const store = createFakeStore(db)
    const startedAt = new Date(NOW.getTime() - 3_600_000)
    const resolvedAt = new Date(NOW.getTime() - 60_000)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incident({
            state: "resolved",
            startedAt: startedAt.toISOString(),
            resolvedAt: resolvedAt.toISOString(),
            updatedAt: NOW.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }

    await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })

    expect(db.incidentResolvedAt.get("vercel:inc-1")).toEqual(resolvedAt)
  })
})

// -- F4: the new-open-interval insert tolerates a lost close-then-insert race
// by targeting the dependency_state_intervals_one_open partial unique index
// with ON CONFLICT DO NOTHING, so a concurrent close no longer aborts the
// whole poll. The real fix lives in the Drizzle-backed store, which the
// in-memory fake never exercises, so this asserts the clause shape.

describe("createSqlPersistStore: F4 tolerant open-interval insert", () => {
  it("targets the one-open partial unique index with ON CONFLICT DO NOTHING", () => {
    const source = readFileSync(
      new URL("./persist.ts", import.meta.url),
      "utf8"
    )
    const insertBlock = source.slice(
      source.indexOf(".insert(dependencyStateIntervals)")
    )
    expect(insertBlock).toMatch(/onConflictDoNothing\(\{/)
    expect(insertBlock).toMatch(
      /target:\s*dependencyStateIntervals\.dependencyId/
    )
    expect(insertBlock).toMatch(
      /where:\s*sql`\$\{dependencyStateIntervals\.endedAt\} is null`/
    )
  })
})

// -- W4: match-scope contract + fidelity-aware recovery -------------------

describe("IncidentMatchScope constructors and notification gates", () => {
  it("builds valid scopes and rejects empty component scope", () => {
    expect(componentIncidentScope(["a"]).kind).toBe("components")
    expect(sourceIncidentScope()).toEqual({ kind: "source" })
    expect(unmappedIncidentScope()).toEqual({ kind: "unmapped" })
    expect(scopeFromComponentIds([])).toEqual({ kind: "unmapped" })
    expect(scopeFromComponentIds(["x"]).kind).toBe("components")
    expect(() => componentIncidentScope([])).toThrow(/at least one/)
  })

  it("opens notifications per scope + dependency state", () => {
    expect(
      shouldNotifyDependencyIncident(sourceIncidentScope(), "OPERATIONAL")
    ).toBe(true)
    expect(
      shouldNotifyDependencyIncident(sourceIncidentScope(), "UNKNOWN")
    ).toBe(true)
    expect(
      shouldNotifyDependencyIncident(componentIncidentScope(["c1"]), "OUTAGE")
    ).toBe(true)
    expect(
      shouldNotifyDependencyIncident(componentIncidentScope(["c1"]), "DEGRADED")
    ).toBe(true)
    expect(
      shouldNotifyDependencyIncident(
        componentIncidentScope(["c1"]),
        "MAINTENANCE"
      )
    ).toBe(true)
    expect(
      shouldNotifyDependencyIncident(
        componentIncidentScope(["c1"]),
        "OPERATIONAL"
      )
    ).toBe(false)
    expect(
      shouldNotifyDependencyIncident(unmappedIncidentScope(), "OUTAGE")
    ).toBe(false)
  })

  it("defers recovery by fidelity + final state", () => {
    expect(shouldNotifyDependencyRecovery("component", "OPERATIONAL")).toBe(
      true
    )
    expect(shouldNotifyDependencyRecovery("component", "UNKNOWN")).toBe(false)
    expect(shouldNotifyDependencyRecovery("component", "OUTAGE")).toBe(false)
    expect(shouldNotifyDependencyRecovery("incident_only", "UNKNOWN")).toBe(
      true
    )
    expect(shouldNotifyDependencyRecovery("incident_only", "OPERATIONAL")).toBe(
      true
    )
    expect(shouldNotifyDependencyRecovery("incident_only", "DEGRADED")).toBe(
      false
    )
  })
})

describe("persistSnapshot: W4 match-scope and fidelity recovery", () => {
  it("AWS active with no service ids: stores the incident, creates no matches or alerts", async () => {
    const db = emptyDb([
      dependencyRow({
        id: "dep-ec2",
        selector: {
          kind: "component_ids",
          aggregation: "worst_of",
          ids: ["ec2-us-east-1"],
        },
      }),
    ])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        componentsComplete: false,
        components: {},
        incidents: [incident({ scope: unmappedIncidentScope() })],
      }),
      etag: null,
      lastModified: null,
    }
    const summary = await persistSnapshot(
      store,
      outcome,
      baseSource({ adapter: "aws_health" }),
      { now: NOW, defaultRecipients: ["ops@example.com"] }
    )

    expect(summary.incidentsUpserted).toBe(1)
    expect(db.incidentsBySourceExternal.size).toBe(1)
    expect(db.matches.size).toBe(0)
    expect(db.incidentComponentPairs.size).toBe(0)
    expect(summary.notificationsEnqueued).toBe(0)
  })

  it("same event later gains component ids: only intersecting deps match and notify", async () => {
    const db = emptyDb([
      dependencyRow({
        id: "dep-ec2",
        selector: {
          kind: "component_ids",
          aggregation: "worst_of",
          ids: ["ec2-us-east-1"],
        },
      }),
      dependencyRow({
        id: "dep-s3",
        catalogId: "aws_s3",
        selector: {
          kind: "component_ids",
          aggregation: "worst_of",
          ids: ["s3-us-east-1"],
        },
      }),
    ])
    const store = createFakeStore(db)
    const source = baseSource({ adapter: "aws_health" })

    const unmapped: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        componentsComplete: false,
        components: {},
        incidents: [incident({ scope: unmappedIncidentScope() })],
      }),
      etag: null,
      lastModified: null,
    }
    const withIds: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        componentsComplete: false,
        components: { "ec2-us-east-1": { state: "OUTAGE", updatedAt: null } },
        incidents: [incident({ componentIds: ["ec2-us-east-1"] })],
      }),
      etag: null,
      lastModified: null,
    }

    const poll1 = await persistSnapshot(store, unmapped, source, {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })
    const poll2 = await persistSnapshot(store, withIds, source, {
      now: new Date(NOW.getTime() + 60_000),
      defaultRecipients: ["ops@example.com"],
    })

    expect(poll1.notificationsEnqueued).toBe(0)
    expect(poll2.notificationsEnqueued).toBe(1)
    expect(db.notifications[0]?.dependencyId).toBe("dep-ec2")
    expect(db.matches.size).toBe(1)
    expect([...db.matches][0]).toContain("dep-ec2")
  })

  it("previously scoped becomes unmapped: existing matches remain, no new match", async () => {
    const db = emptyDb([dependencyRow({ id: "dep-1" })])
    const store = createFakeStore(db)
    const source = baseSource({ adapter: "aws_health" })

    const scoped: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        componentsComplete: false,
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [incident({ componentIds: ["c1"] })],
      }),
      etag: null,
      lastModified: null,
    }
    const unmapped: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        componentsComplete: false,
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [incident({ scope: unmappedIncidentScope() })],
      }),
      etag: null,
      lastModified: null,
    }

    await persistSnapshot(store, scoped, source, {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })
    expect(db.matches.size).toBe(1)
    const matchesAfterScoped = new Set(db.matches)

    await persistSnapshot(store, unmapped, source, {
      now: new Date(NOW.getTime() + 60_000),
      defaultRecipients: ["ops@example.com"],
    })
    expect(db.matches).toEqual(matchesAfterScoped)
    // Still open, already matched: no second incident alert.
    expect(db.notifications.map((n) => n.event)).toEqual(["incident"])
  })

  it("component names sibling scope: correlation persists, operational scoped dep gets no open alert", async () => {
    const db = emptyDb([
      dependencyRow({
        id: "dep-us",
        catalogId: "neon_database",
        scopeId: "us-east-1",
        currentState: "OPERATIONAL",
        selector: {
          kind: "statusio_component_container",
          componentId: "c1",
          container: { required: true },
        },
      }),
    ])
    const store = createFakeStore(db)
    const outcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: {
          c1: { state: "OUTAGE", updatedAt: null },
          "us-east-1": { state: "OPERATIONAL", updatedAt: null },
        },
        incidents: [incident({ componentIds: ["c1"] })],
      }),
      etag: null,
      lastModified: null,
    }
    const summary = await persistSnapshot(store, outcome, baseSource(), {
      now: NOW,
      defaultRecipients: ["ops@example.com"],
    })

    expect(summary.notificationsEnqueued).toBe(0)
    expect(db.matches.size).toBe(1)
    expect(db.installed[0]?.currentState).toBe("OPERATIONAL")
  })

  it("source-wide resolves while another component incident keeps degraded: no recovery yet", async () => {
    const db = emptyDb([dependencyRow({ id: "dep-1", fidelity: "component" })])
    const store = createFakeStore(db)
    const source = baseSource()
    const t0 = NOW
    const t1 = new Date(NOW.getTime() + 60_000)
    const t2 = new Date(NOW.getTime() + 120_000)

    const bothActive: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [
          incident({ externalId: "src-wide", scope: sourceIncidentScope() }),
          incident({ externalId: "comp-inc", componentIds: ["c1"] }),
        ],
      }),
      etag: null,
      lastModified: null,
    }
    const sourceResolved: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [
          incident({
            externalId: "src-wide",
            scope: sourceIncidentScope(),
            resolvedAt: t1.toISOString(),
            updatedAt: t1.toISOString(),
          }),
          incident({
            externalId: "comp-inc",
            componentIds: ["c1"],
            updatedAt: t1.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }
    const bothResolved: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incident({
            externalId: "src-wide",
            scope: sourceIncidentScope(),
            resolvedAt: t1.toISOString(),
            updatedAt: t1.toISOString(),
          }),
          incident({
            externalId: "comp-inc",
            componentIds: ["c1"],
            resolvedAt: t2.toISOString(),
            updatedAt: t2.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }

    const poll1 = await persistSnapshot(store, bothActive, source, {
      now: t0,
      defaultRecipients: ["ops@example.com"],
    })
    const poll2 = await persistSnapshot(store, sourceResolved, source, {
      now: t1,
      defaultRecipients: ["ops@example.com"],
    })
    const poll3 = await persistSnapshot(store, bothResolved, source, {
      now: t2,
      defaultRecipients: ["ops@example.com"],
    })

    expect(poll1.notificationsEnqueued).toBe(2)
    expect(poll2.notificationsEnqueued).toBe(0)
    expect(poll3.notificationsEnqueued).toBe(1)
    expect(db.notifications.map((n) => n.event)).toEqual([
      "incident",
      "incident",
      "recovery",
    ])
  })

  it("final active resolves + operational: one recovery", async () => {
    const db = emptyDb([dependencyRow({ id: "dep-1" })])
    const store = createFakeStore(db)
    const t0 = NOW
    const t1 = new Date(NOW.getTime() + 60_000)

    await persistSnapshot(
      store,
      {
        sourceId: "vercel",
        kind: "snapshot",
        snapshot: snapshotWith({
          components: { c1: { state: "OUTAGE", updatedAt: null } },
          incidents: [incident()],
        }),
        etag: null,
        lastModified: null,
      },
      baseSource(),
      { now: t0, defaultRecipients: ["ops@example.com"] }
    )

    const poll2 = await persistSnapshot(
      store,
      {
        sourceId: "vercel",
        kind: "snapshot",
        snapshot: snapshotWith({
          components: { c1: { state: "OPERATIONAL", updatedAt: null } },
          incidents: [
            incident({
              resolvedAt: t1.toISOString(),
              updatedAt: t1.toISOString(),
            }),
          ],
        }),
        etag: null,
        lastModified: null,
      },
      baseSource(),
      { now: t1, defaultRecipients: ["ops@example.com"] }
    )

    expect(poll2.notificationsEnqueued).toBe(1)
    expect(db.notifications.map((n) => n.event)).toEqual([
      "incident",
      "recovery",
    ])
  })

  it("incident-only feed resolves while unknown: one recovery", async () => {
    const db = emptyDb([
      dependencyRow({
        id: "dep-1",
        fidelity: "incident_only",
        selector: {
          kind: "component_ids",
          aggregation: "worst_of",
          ids: ["feed"],
        },
      }),
    ])
    const store = createFakeStore(db)
    const source = baseSource({ adapter: "incident_feed" })
    const t0 = NOW
    const t1 = new Date(NOW.getTime() + 60_000)

    await persistSnapshot(
      store,
      {
        sourceId: "vercel",
        kind: "snapshot",
        snapshot: snapshotWith({
          componentsComplete: true,
          incidentsComplete: false,
          components: {},
          incidents: [incident({ scope: sourceIncidentScope() })],
        }),
        etag: null,
        lastModified: null,
      },
      source,
      { now: t0, defaultRecipients: ["ops@example.com"] }
    )

    const poll2 = await persistSnapshot(
      store,
      {
        sourceId: "vercel",
        kind: "snapshot",
        snapshot: snapshotWith({
          componentsComplete: true,
          incidentsComplete: false,
          components: {},
          incidents: [
            incident({
              scope: sourceIncidentScope(),
              state: "resolved",
              resolvedAt: t1.toISOString(),
              updatedAt: t1.toISOString(),
            }),
          ],
        }),
        etag: null,
        lastModified: null,
      },
      source,
      { now: t1, defaultRecipients: ["ops@example.com"] }
    )

    expect(poll2.notificationsEnqueued).toBe(1)
    expect(db.installed[0]?.currentState).toBe("UNKNOWN")
    expect(db.notifications.map((n) => n.event)).toEqual([
      "incident",
      "recovery",
    ])
  })

  it("repeated terminal resolution enqueues no duplicate recovery", async () => {
    const db = emptyDb([dependencyRow({ id: "dep-1" })])
    const store = createFakeStore(db)
    const t0 = NOW
    const t1 = new Date(NOW.getTime() + 60_000)
    const resolved = {
      sourceId: "vercel" as const,
      kind: "snapshot" as const,
      snapshot: snapshotWith({
        components: { c1: { state: "OPERATIONAL", updatedAt: null } },
        incidents: [
          incident({
            resolvedAt: t1.toISOString(),
            updatedAt: t1.toISOString(),
          }),
        ],
      }),
      etag: null,
      lastModified: null,
    }

    await persistSnapshot(
      store,
      {
        sourceId: "vercel",
        kind: "snapshot",
        snapshot: snapshotWith({
          components: { c1: { state: "OUTAGE", updatedAt: null } },
          incidents: [incident()],
        }),
        etag: null,
        lastModified: null,
      },
      baseSource(),
      { now: t0, defaultRecipients: ["ops@example.com"] }
    )

    const poll2 = await persistSnapshot(store, resolved, baseSource(), {
      now: t1,
      defaultRecipients: ["ops@example.com"],
    })
    const poll3 = await persistSnapshot(store, resolved, baseSource(), {
      now: new Date(t1.getTime() + 60_000),
      defaultRecipients: ["ops@example.com"],
    })

    expect(poll2.notificationsEnqueued).toBe(1)
    expect(poll3.notificationsEnqueued).toBe(0)
    expect(db.notifications.filter((n) => n.event === "recovery")).toHaveLength(
      1
    )
  })

  it("explicit terminal and disappearance paths use the same recovery policy inputs", async () => {
    // Terminal path: component fidelity + OUTAGE defers recovery.
    expect(shouldNotifyDependencyRecovery("component", "OUTAGE")).toBe(false)
    expect(shouldNotifyDependencyRecovery("component", "OPERATIONAL")).toBe(
      true
    )
    // Disappearance path must call the same helper (see persist.ts). Prove both
    // policy inputs: fidelity from the install row, finalStates[dependencyId].
    const db = emptyDb([
      dependencyRow({ id: "dep-1", currentState: "OPERATIONAL" }),
    ])
    const store = createFakeStore(db)

    await persistSnapshot(
      store,
      {
        sourceId: "vercel",
        kind: "snapshot",
        snapshot: snapshotWith({
          components: { c1: { state: "OUTAGE", updatedAt: null } },
          incidents: [incident()],
        }),
        etag: null,
        lastModified: null,
      },
      baseSource(),
      { now: NOW, defaultRecipients: ["ops@example.com"] }
    )

    // Still degraded by residual state while the incident disappears: deferred.
    const stillOutage: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        incidentsComplete: true,
        components: { c1: { state: "OUTAGE", updatedAt: null } },
        incidents: [],
      }),
      etag: null,
      lastModified: null,
    }
    const deferred = await persistSnapshot(store, stillOutage, baseSource(), {
      now: new Date(NOW.getTime() + 60_000),
      defaultRecipients: ["ops@example.com"],
    })
    expect(deferred.notificationsEnqueued).toBe(0)

    // Re-open then disappear when operational: recovery fires once.
    await persistSnapshot(
      store,
      {
        sourceId: "vercel",
        kind: "snapshot",
        snapshot: snapshotWith({
          incidentsComplete: true,
          components: { c1: { state: "OUTAGE", updatedAt: null } },
          incidents: [incident({ externalId: "inc-2" })],
        }),
        etag: null,
        lastModified: null,
      },
      baseSource(),
      {
        now: new Date(NOW.getTime() + 120_000),
        defaultRecipients: ["ops@example.com"],
      }
    )

    const recovered = await persistSnapshot(
      store,
      {
        sourceId: "vercel",
        kind: "snapshot",
        snapshot: snapshotWith({
          incidentsComplete: true,
          components: { c1: { state: "OPERATIONAL", updatedAt: null } },
          incidents: [],
        }),
        etag: null,
        lastModified: null,
      },
      baseSource(),
      {
        now: new Date(NOW.getTime() + 180_000),
        defaultRecipients: ["ops@example.com"],
      }
    )

    expect(recovered.notificationsEnqueued).toBe(1)
    expect(db.notifications.filter((n) => n.event === "recovery")).toHaveLength(
      1
    )
  })

  it("component fidelity defers recovery at UNKNOWN on disappearance", async () => {
    const db = emptyDb([dependencyRow({ id: "dep-1", fidelity: "component" })])
    const store = createFakeStore(db)

    await persistSnapshot(
      store,
      {
        sourceId: "vercel",
        kind: "snapshot",
        snapshot: snapshotWith({
          components: { c1: { state: "OUTAGE", updatedAt: null } },
          incidents: [incident()],
        }),
        etag: null,
        lastModified: null,
      },
      baseSource(),
      { now: NOW, defaultRecipients: ["ops@example.com"] }
    )

    // Feed becomes complete with no components (gone selector → UNKNOWN).
    const vanishedUnknown: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        incidentsComplete: true,
        componentsComplete: true,
        components: {},
        incidents: [],
      }),
      etag: null,
      lastModified: null,
    }
    const summary = await persistSnapshot(
      store,
      vanishedUnknown,
      baseSource(),
      {
        now: new Date(NOW.getTime() + 60_000),
        defaultRecipients: ["ops@example.com"],
      }
    )

    expect(db.installed[0]?.currentState).toBe("UNKNOWN")
    expect(summary.notificationsEnqueued).toBe(0)
    expect(db.notifications.filter((n) => n.event === "recovery")).toHaveLength(
      0
    )
  })

  it("incident_only fidelity recovers at UNKNOWN on disappearance", async () => {
    const db = emptyDb([
      dependencyRow({
        id: "dep-1",
        fidelity: "incident_only",
        selector: {
          kind: "component_ids",
          aggregation: "worst_of",
          ids: ["feed"],
        },
      }),
    ])
    const store = createFakeStore(db)
    // Use an incidentsComplete adapter so disappearance closes the incident,
    // while componentsComplete true leaves the incident_only install at UNKNOWN.
    const source = baseSource({ adapter: "statuspage_v2" })

    await persistSnapshot(
      store,
      {
        sourceId: "vercel",
        kind: "snapshot",
        snapshot: snapshotWith({
          componentsComplete: true,
          incidentsComplete: true,
          components: {},
          incidents: [incident({ scope: sourceIncidentScope() })],
        }),
        etag: null,
        lastModified: null,
      },
      source,
      { now: NOW, defaultRecipients: ["ops@example.com"] }
    )

    expect(db.installed[0]?.currentState).toBe("UNKNOWN")

    const vanished: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        componentsComplete: true,
        incidentsComplete: true,
        components: {},
        incidents: [],
      }),
      etag: null,
      lastModified: null,
    }
    const summary = await persistSnapshot(store, vanished, source, {
      now: new Date(NOW.getTime() + 60_000),
      defaultRecipients: ["ops@example.com"],
    })

    expect(db.installed[0]?.currentState).toBe("UNKNOWN")
    expect(summary.notificationsEnqueued).toBe(1)
    expect(db.notifications.map((n) => n.event)).toEqual([
      "incident",
      "recovery",
    ])
  })
})

// -- W5: Azure active_only inventory closes on a successful empty snapshot.

describe("persistSnapshot: Azure active_only empty-channel closure", () => {
  function azureInstall() {
    return dependencyRow({
      id: "dep-azure",
      fidelity: "incident_only",
      selector: {
        kind: "component_ids",
        aggregation: "worst_of",
        ids: ["incident-feed"],
      },
    })
  }

  function azureSource() {
    return baseSource({ adapter: "incident_feed", provider: "Azure" })
  }

  it("active then empty complete snapshot closes once with one incident_only recovery", async () => {
    const db = emptyDb([azureInstall()])
    const store = createFakeStore(db)
    const source = azureSource()

    await persistSnapshot(
      store,
      {
        sourceId: "vercel",
        kind: "snapshot",
        snapshot: snapshotWith({
          componentsComplete: true,
          incidentsComplete: true,
          components: {},
          incidents: [incident({ scope: sourceIncidentScope() })],
        }),
        etag: null,
        lastModified: null,
      },
      source,
      { now: NOW, defaultRecipients: ["ops@example.com"] }
    )

    expect(db.installed[0]?.currentState).toBe("UNKNOWN")
    expect(db.notifications.map((n) => n.event)).toEqual(["incident"])

    const empty = await persistSnapshot(
      store,
      {
        sourceId: "vercel",
        kind: "snapshot",
        snapshot: snapshotWith({
          componentsComplete: true,
          incidentsComplete: true,
          components: {},
          incidents: [],
        }),
        etag: null,
        lastModified: null,
      },
      source,
      {
        now: new Date(NOW.getTime() + 60_000),
        defaultRecipients: ["ops@example.com"],
      }
    )

    expect(empty.notificationsEnqueued).toBe(1)
    expect(db.notifications.map((n) => n.event)).toEqual([
      "incident",
      "recovery",
    ])
    expect(db.incidentResolvedAt.get("vercel:inc-1")).toBeInstanceOf(Date)
  })

  it("repeated empty complete snapshots enqueue no duplicate recovery", async () => {
    const db = emptyDb([azureInstall()])
    const store = createFakeStore(db)
    const source = azureSource()
    const emptyOutcome: PollOutcome = {
      sourceId: "vercel",
      kind: "snapshot",
      snapshot: snapshotWith({
        componentsComplete: true,
        incidentsComplete: true,
        components: {},
        incidents: [],
      }),
      etag: null,
      lastModified: null,
    }

    await persistSnapshot(
      store,
      {
        sourceId: "vercel",
        kind: "snapshot",
        snapshot: snapshotWith({
          componentsComplete: true,
          incidentsComplete: true,
          components: {},
          incidents: [incident({ scope: sourceIncidentScope() })],
        }),
        etag: null,
        lastModified: null,
      },
      source,
      { now: NOW, defaultRecipients: ["ops@example.com"] }
    )

    await persistSnapshot(store, emptyOutcome, source, {
      now: new Date(NOW.getTime() + 60_000),
      defaultRecipients: ["ops@example.com"],
    })
    const again = await persistSnapshot(store, emptyOutcome, source, {
      now: new Date(NOW.getTime() + 120_000),
      defaultRecipients: ["ops@example.com"],
    })

    expect(again.notificationsEnqueued).toBe(0)
    expect(db.notifications.filter((n) => n.event === "recovery")).toHaveLength(
      1
    )
  })

  it("a non-complete empty-looking snapshot (malformed path never reaches here as complete) leaves the incident open", async () => {
    // Adapter parse failures never produce a snapshot. An incomplete empty
    // snapshot is the only empty-looking shape persist can see without closing.
    const db = emptyDb([azureInstall()])
    const store = createFakeStore(db)
    const source = azureSource()

    await persistSnapshot(
      store,
      {
        sourceId: "vercel",
        kind: "snapshot",
        snapshot: snapshotWith({
          componentsComplete: true,
          incidentsComplete: true,
          components: {},
          incidents: [incident({ scope: sourceIncidentScope() })],
        }),
        etag: null,
        lastModified: null,
      },
      source,
      { now: NOW, defaultRecipients: ["ops@example.com"] }
    )

    const incompleteEmpty = await persistSnapshot(
      store,
      {
        sourceId: "vercel",
        kind: "snapshot",
        snapshot: snapshotWith({
          componentsComplete: true,
          incidentsComplete: false,
          components: {},
          incidents: [],
        }),
        etag: null,
        lastModified: null,
      },
      source,
      {
        now: new Date(NOW.getTime() + 60_000),
        defaultRecipients: ["ops@example.com"],
      }
    )

    expect(incompleteEmpty.notificationsEnqueued).toBe(0)
    expect(db.incidentResolvedAt.get("vercel:inc-1")).toBeNull()
    expect(db.notifications.map((n) => n.event)).toEqual(["incident"])
  })
})

// -- W5: provider update rows are monotonic snapshots, not insert-only.

describe("createSqlPersistStore: W5 monotonic incident update upsert", () => {
  it("uses onConflictDoUpdate with newer-timestamp and same-timestamp material correction guards", () => {
    const source = readFileSync(
      new URL("./persist.ts", import.meta.url),
      "utf8"
    )
    const block = source.slice(
      source.indexOf("async upsertIncidentUpdates(incidentId, updates)")
    )
    expect(block).toMatch(/onConflictDoUpdate\(\{/)
    expect(block).toMatch(/excluded\.provider_updated_at >/)
    expect(block).toMatch(/IS DISTINCT FROM/)
    expect(block).toMatch(/least\(/)
    expect(block).toMatch(/provider_created_at/)
    expect(block).not.toMatch(
      /upsertIncidentUpdates[\s\S]{0,800}onConflictDoNothing\(\)/
    )
  })
})
