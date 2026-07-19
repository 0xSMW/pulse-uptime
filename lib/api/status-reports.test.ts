import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db: {} }));

import { encodeCursor } from "./pagination";
import {
  addReportUpdate,
  classifyPublicReport,
  compareReportUpdates,
  createStatusReport,
  databaseStatusReportsStore,
  deleteReportUpdate,
  deleteStatusReport,
  deriveResolvedAt,
  editReportUpdate,
  getPublicReports,
  getStatusReport,
  listStatusReports,
  listStatusReportSummaries,
  MAX_AFFECTED_PER_REPORT,
  parseStatusReportListQuery,
  promoteIncident,
  publicIncidentCause,
  publishStatusReport,
  recoverAddedReportUpdate,
  recoverCreatedStatusReport,
  recoverDeletedReportUpdate,
  recoverDeletedStatusReport,
  recoverEditedReportUpdate,
  recoverPromotedReport,
  recoverPublishedStatusReport,
  StatusReportError,
  updateStatusReport,
  type StatusReportAffectedRow,
  type StatusReportRow,
  type StatusReportsStore,
  type StatusReportUpdateRow,
} from "./status-reports";

const NOW = new Date("2026-07-18T12:00:00.000Z");

type MemoryStore = StatusReportsStore & {
  reports: Map<string, StatusReportRow>;
  updates: Map<string, StatusReportUpdateRow>;
  affected: StatusReportAffectedRow[];
  incidents: Map<string, { id: string; monitorId: string; monitorName: string; groupName: string | null; openedAt: Date; openingStatusCode: number | null }>;
};

function memoryStore(monitors: Array<{ id: string; name: string; groupName: string | null }> = [
  { id: "api-prod", name: "API (production)", groupName: "Core" },
  { id: "web", name: "Website", groupName: null },
]): MemoryStore {
  const reports = new Map<string, StatusReportRow>();
  const updates = new Map<string, StatusReportUpdateRow>();
  let affected: StatusReportAffectedRow[] = [];
  const incidents = new Map<string, { id: string; monitorId: string; monitorName: string; groupName: string | null; openedAt: Date; openingStatusCode: number | null }>();

  // Per-report async lock mirroring the DB's `SELECT ... FOR UPDATE`
  // transaction in recomputeResolution: calls for the SAME reportId are
  // chained so the next one's read only starts after the prior one's write
  // has settled, so a lagging recompute never clobbers a newer, correct
  // write with a stale value.
  const reportLocks = new Map<string, Promise<unknown>>();
  function withReportLock<T>(reportId: string, fn: () => Promise<T>): Promise<T> {
    const prior = reportLocks.get(reportId) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    reportLocks.set(reportId, run.then(() => undefined, () => undefined));
    return run;
  }

  const store: MemoryStore = {
    reports,
    updates,
    get affected() { return affected; },
    set affected(value) { affected = value; },
    incidents,

    async findMonitors(ids) {
      return monitors.filter((monitor) => ids.includes(monitor.id));
    },
    async insertReport(input) {
      reports.set(input.report.id, { ...input.report });
      updates.set(input.update.id, { ...input.update });
      affected.push(...input.affected.map((row) => ({ ...row })));
    },
    async insertPromotedReport(input) {
      const existing = [...reports.values()].find((row) => row.originIncidentId === input.report.originIncidentId);
      if (existing) return { id: existing.id, created: false };
      await store.insertReport(input);
      return { id: input.report.id, created: true };
    },
    async getReport(id) {
      const row = reports.get(id);
      return row ? { ...row } : null;
    },
    async listReports({ state, type, cursor, limit }) {
      let rows = [...reports.values()];
      if (state === "draft") rows = rows.filter((row) => row.publishedAt === null);
      if (state === "ongoing") rows = rows.filter((row) => row.publishedAt !== null && row.resolvedAt === null);
      if (state === "resolved") rows = rows.filter((row) => row.publishedAt !== null && row.resolvedAt !== null);
      if (type !== "all") rows = rows.filter((row) => row.type === type);
      rows.sort((left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id));
      if (cursor) {
        rows = rows.filter((row) =>
          row.createdAt.getTime() < cursor.createdAt.getTime()
          || (row.createdAt.getTime() === cursor.createdAt.getTime() && row.id < cursor.id));
      }
      return rows.slice(0, limit + 1).map((row) => ({ ...row }));
    },
    async getReportDetails(ids) {
      return {
        updates: [...updates.values()].filter((row) => ids.includes(row.reportId)).map((row) => ({ ...row })),
        affected: affected.filter((row) => ids.includes(row.reportId)).map((row) => ({ ...row })),
      };
    },
    async getListDetails(ids) {
      const latest = await store.getLatestUpdates(ids);
      return {
        counts: ids
          .map((reportId) => ({
            reportId,
            count: [...updates.values()].filter((row) => row.reportId === reportId).length,
          }))
          .filter((entry) => entry.count > 0),
        latest: latest.map((row) => ({ reportId: row.reportId, status: row.status, publishedAt: row.publishedAt })),
        affected: affected.filter((row) => ids.includes(row.reportId)).map((row) => ({ ...row })),
      };
    },
    async updateReport({ id, patch, affected: replacement, now }) {
      const row = reports.get(id);
      if (!row) return null;
      Object.assign(row, patch, { updatedAt: now });
      if (replacement !== undefined) {
        affected = affected.filter((entry) => entry.reportId !== id);
        affected.push(...replacement.map((entry) => ({ ...entry })));
      }
      return { ...row };
    },
    async deleteReport(id) {
      const existed = reports.delete(id);
      for (const [key, row] of updates) if (row.reportId === id) updates.delete(key);
      affected = affected.filter((entry) => entry.reportId !== id);
      return existed;
    },
    async insertUpdate(row) {
      updates.set(row.id, { ...row });
    },
    async insertReportUpdate({ reportId, update }) {
      // Mirrors the DB's locked contract: re-check existence, then insert,
      // as one atomic step: a report deleted between an earlier
      // (unlocked) existence check and this call is caught here rather
      // than corrupting an FK relationship the way an unguarded insert
      // would.
      return withReportLock(reportId, async () => {
        const row = reports.get(reportId);
        if (!row) return null;
        updates.set(update.id, { ...update });
        return { ...row };
      });
    },
    async editUpdate({ reportId, updateId, patch, now }) {
      const row = updates.get(updateId);
      if (!row || row.reportId !== reportId) return null;
      Object.assign(row, patch, { updatedAt: now });
      return { ...row };
    },
    async deleteUpdate({ reportId, updateId }) {
      // Mirrors the guarded single-statement contract: the row is only
      // removed while another update for the report exists.
      const row = updates.get(updateId);
      if (!row || row.reportId !== reportId) return "missing";
      const siblings = [...updates.values()].filter((entry) => entry.reportId === reportId);
      if (siblings.length <= 1) return "last_update";
      updates.delete(updateId);
      return "deleted";
    },
    async getUpdate(reportId, updateId) {
      const row = updates.get(updateId);
      return row && row.reportId === reportId ? { ...row } : null;
    },
    async recomputeResolution({ reportId, now }) {
      // Mirrors the FOR-UPDATE-locked transaction contract: recomputes for
      // the SAME reportId are chained through a per-report lock so a call
      // queued behind another always reads the state left by the one before
      // it, rather than a snapshot that call's write could later invalidate.
      return withReportLock(reportId, async () => {
        const row = reports.get(reportId);
        if (!row) return null;
        const currentUpdates = [...updates.values()]
          .filter((entry) => entry.reportId === reportId)
          .map((entry) => ({ ...entry }));
        const resolvedAt = deriveResolvedAt(currentUpdates);
        Object.assign(row, { resolvedAt, updatedAt: now });
        return { updates: currentUpdates, resolvedAt };
      });
    },
    async publishReport({ id, now }) {
      const row = reports.get(id);
      if (!row) return "missing";
      if (row.publishedAt !== null) return "already_published";
      row.publishedAt = now;
      row.updatedAt = now;
      return "published";
    },
    async findIncident(incidentId) {
      return incidents.get(incidentId) ?? null;
    },
    async getPublicReportRows({ resolvedLimit, now, filter }) {
      // Deliberately sloppier than the SQL (includes drafts) so the service's
      // own draft filter is exercised.
      let rows = [...reports.values()];
      if (filter) {
        const monitorIds = new Set(filter.monitorIds);
        const groupNames = new Set(filter.groupNames);
        const matching = new Set(
          affected
            .filter((row) => monitorIds.has(row.monitorId) || groupNames.has(row.groupName ?? "Other"))
            .map((row) => row.reportId),
        );
        rows = rows.filter((row) => matching.has(row.id));
      }
      // Mirrors ORDER BY (ended, future, CASE WHEN future THEN starts_at END
      // ASC NULLS LAST, starts_at desc): truly active rows (started, not
      // ended) sort first, most-recently-started first, then
      // future-scheduled rows sorted NEAREST-first, then ended-but-uncompleted
      // windows last, so the 100 cap can never let future maintenance OR a
      // stale ended window crowd out an active report, and among future rows
      // never drops the SOONEST upcoming ones in favor of the farthest.
      const unresolved = rows
        .filter((row) => row.resolvedAt === null)
        .sort((left, right) => {
          const leftEnded = left.endsAt !== null && left.endsAt.getTime() <= now.getTime() ? 1 : 0;
          const rightEnded = right.endsAt !== null && right.endsAt.getTime() <= now.getTime() ? 1 : 0;
          if (leftEnded !== rightEnded) return leftEnded - rightEnded;
          const leftFuture = left.startsAt.getTime() > now.getTime() ? 1 : 0;
          const rightFuture = right.startsAt.getTime() > now.getTime() ? 1 : 0;
          if (leftFuture !== rightFuture) return leftFuture - rightFuture;
          if (leftFuture === 1) return left.startsAt.getTime() - right.startsAt.getTime();
          return right.startsAt.getTime() - left.startsAt.getTime();
        })
        .slice(0, 100);
      const resolved = rows.filter((row) => row.resolvedAt !== null)
        .sort((left, right) => right.resolvedAt!.getTime() - left.resolvedAt!.getTime())
        .slice(0, resolvedLimit);
      return [...unresolved, ...resolved].map((row) => ({ ...row }));
    },
    async getLatestUpdates(reportIds) {
      const result: StatusReportUpdateRow[] = [];
      for (const reportId of reportIds) {
        const rows = [...updates.values()].filter((row) => row.reportId === reportId);
        const latest = rows.sort(compareReportUpdates).at(-1);
        if (latest) result.push({ ...latest });
      }
      return result;
    },
    async getAffected(reportIds) {
      return affected.filter((row) => reportIds.includes(row.reportId)).map((row) => ({ ...row }));
    },
    async getReportByOriginIncident(incidentId) {
      const row = [...reports.values()].find((entry) => entry.originIncidentId === incidentId);
      return row ? { ...row } : null;
    },
  };
  return store;
}

function sequentialIds(prefix: string) {
  let counter = 0;
  return () => `${prefix}-${String(++counter).padStart(4, "0")}`;
}

/**
 * UUID-shaped sequential ids for tests that round-trip an id through a list
 * cursor: parseStatusReportListQuery validates the decoded cursor id against
 * the UUID pattern, so fixtures feeding a real cursor need genuinely
 * UUID-shaped ids.
 */
function sequentialUuids() {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };
}

function dependencies(store: MemoryStore, now: Date = NOW) {
  return { store, now: () => now, newId: sequentialIds("id") };
}

const validCreate = {
  type: "incident" as const,
  title: "API outage",
  affected: [{ monitorId: "api-prod", impact: "down" as const }],
  update: { status: "investigating" as const, markdown: "We are investigating." },
};

describe("status derivation", () => {
  const base = { reportId: "rep", markdown: "x", updatedAt: NOW };
  const update = (id: string, status: StatusReportUpdateRow["status"], publishedAt: string, createdAt: string): StatusReportUpdateRow => ({
    ...base, id, status, publishedAt: new Date(publishedAt), createdAt: new Date(createdAt),
  });

  it("orders updates by (publishedAt, createdAt, id) — the tiebreak is contractual", () => {
    const a = update("aaa", "investigating", "2026-07-18T10:00:00Z", "2026-07-18T10:00:00Z");
    const b = update("bbb", "monitoring", "2026-07-18T10:00:00Z", "2026-07-18T10:00:00Z");
    const c = update("ccc", "identified", "2026-07-18T10:00:00Z", "2026-07-18T09:00:00Z");
    const d = update("ddd", "resolved", "2026-07-18T11:00:00Z", "2026-07-18T08:00:00Z");
    expect([b, d, a, c].sort(compareReportUpdates).map((row) => row.id)).toEqual(["ccc", "aaa", "bbb", "ddd"]);
  });

  it("derives resolvedAt only when the totally-ordered latest update resolves", () => {
    const resolved = update("aaa", "resolved", "2026-07-18T10:00:00Z", "2026-07-18T10:00:00Z");
    const monitoring = update("bbb", "monitoring", "2026-07-18T11:00:00Z", "2026-07-18T11:00:00Z");
    expect(deriveResolvedAt([resolved])).toEqual(new Date("2026-07-18T10:00:00Z"));
    expect(deriveResolvedAt([resolved, monitoring])).toBeNull();
    expect(deriveResolvedAt([])).toBeNull();
    const completed = update("ccc", "completed", "2026-07-18T12:00:00Z", "2026-07-18T12:00:00Z");
    expect(deriveResolvedAt([monitoring, completed])).toEqual(new Date("2026-07-18T12:00:00Z"));
  });
});

describe("createStatusReport", () => {
  it("creates a published report with its initial update and snapshotted affected rows", async () => {
    const store = memoryStore();
    const report = await createStatusReport(validCreate, dependencies(store));
    expect(report.publishedAt).toBe(NOW.toISOString());
    expect(report.currentStatus).toBe("investigating");
    expect(report.updates).toHaveLength(1);
    expect(report.affected).toEqual([
      { monitorId: "api-prod", monitorName: "API (production)", groupName: "Core", impact: "down" },
    ]);
    expect(report.resolvedAt).toBeNull();
  });

  it("saves a draft when draft: true", async () => {
    const store = memoryStore();
    const report = await createStatusReport({ ...validCreate, draft: true }, dependencies(store));
    expect(report.publishedAt).toBeNull();
  });

  it("requires the initial update and rejects mismatched statuses", async () => {
    const store = memoryStore();
    const withoutUpdate = { type: validCreate.type, title: validCreate.title, affected: validCreate.affected };
    await expect(createStatusReport(withoutUpdate, dependencies(store)))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(createStatusReport(
      { ...validCreate, update: { status: "scheduled", markdown: "x" } },
      dependencies(store),
    )).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(createStatusReport(
      { ...validCreate, type: "maintenance", update: { status: "investigating", markdown: "x" } },
      dependencies(store),
    )).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("enforces title and markdown bounds and unknown affected monitors", async () => {
    const store = memoryStore();
    await expect(createStatusReport({ ...validCreate, title: "x".repeat(161) }, dependencies(store)))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(createStatusReport(
      { ...validCreate, update: { status: "investigating", markdown: "x".repeat(10_241) } },
      dependencies(store),
    )).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(createStatusReport(
      { ...validCreate, affected: [{ monitorId: "ghost", impact: "down" }] },
      dependencies(store),
    )).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects an inverted or zero-length maintenance window (finding: endsAt <= startsAt accepted)", async () => {
    const store = memoryStore();
    await expect(createStatusReport({
      ...validCreate, type: "maintenance",
      startsAt: "2026-07-19T02:00:00.000Z", endsAt: "2026-07-19T00:00:00.000Z",
      update: { status: "scheduled", markdown: "Planned." },
    }, dependencies(store))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(createStatusReport({
      ...validCreate, type: "maintenance",
      startsAt: "2026-07-19T00:00:00.000Z", endsAt: "2026-07-19T00:00:00.000Z",
      update: { status: "scheduled", markdown: "Planned." },
    }, dependencies(store))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // A valid window still succeeds.
    await expect(createStatusReport({
      ...validCreate, type: "maintenance", affected: [],
      startsAt: "2026-07-19T00:00:00.000Z", endsAt: "2026-07-19T02:00:00.000Z",
      update: { status: "scheduled", markdown: "Planned." },
    }, dependencies(store))).resolves.toMatchObject({ startsAt: "2026-07-19T00:00:00.000Z" });
  });

  it("validates endsAt against the EFFECTIVE (defaulted) startsAt when startsAt is omitted (finding: inverted window via default)", async () => {
    const store = memoryStore();
    // startsAt omitted defaults to NOW (2026-07-18T12:00:00.000Z); an endsAt
    // before that must still be rejected, not silently accepted because the
    // schema-level refine only fired when startsAt was explicitly given.
    await expect(createStatusReport({
      ...validCreate, type: "maintenance",
      endsAt: "2026-07-18T10:00:00.000Z",
      update: { status: "scheduled", markdown: "Planned." },
    }, dependencies(store))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // An endsAt after the defaulted startsAt still succeeds.
    await expect(createStatusReport({
      ...validCreate, type: "maintenance", affected: [],
      endsAt: "2026-07-18T14:00:00.000Z",
      update: { status: "scheduled", markdown: "Planned." },
    }, dependencies(store))).resolves.toMatchObject({ startsAt: NOW.toISOString() });
  });

  it("rejects endsAt on an incident report (finding: incidents have no scheduled window; an endsAt classified them as ongoing forever yet ranked as an ended row in the public cap)", async () => {
    const store = memoryStore();
    await expect(createStatusReport({
      ...validCreate, endsAt: "2026-07-19T00:00:00.000Z",
    }, dependencies(store))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // An explicit null is a no-op, not a window, and still succeeds.
    await expect(createStatusReport({
      ...validCreate, endsAt: null,
    }, dependencies(store))).resolves.toMatchObject({ endsAt: null });
  });

  it("rejects an affected impact that doesn't match the report type (finding: a non-UI client could pair impact \"maintenance\" with an incident, or \"down\" with a maintenance report, rendering a contradictory public label)", async () => {
    const store = memoryStore();
    await expect(createStatusReport({
      ...validCreate, affected: [{ monitorId: "api-prod", impact: "maintenance" }],
    }, dependencies(store))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await expect(createStatusReport({
      ...validCreate, type: "maintenance",
      affected: [{ monitorId: "api-prod", impact: "down" }],
      update: { status: "scheduled", markdown: "Planned." },
    }, dependencies(store))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // Degraded is valid for both types; maintenance's own impact is valid too.
    await expect(createStatusReport({
      ...validCreate, affected: [{ monitorId: "api-prod", impact: "degraded" }],
    }, dependencies(store))).resolves.toMatchObject({ affected: [expect.objectContaining({ impact: "degraded" })] });
    await expect(createStatusReport({
      ...validCreate, type: "maintenance",
      affected: [{ monitorId: "api-prod", impact: "maintenance" }],
      update: { status: "scheduled", markdown: "Planned." },
    }, dependencies(store))).resolves.toMatchObject({ affected: [expect.objectContaining({ impact: "maintenance" })] });
  });
});

describe("report update lifecycle", () => {
  it("recomputes resolvedAt when a resolving update is posted, backdated, and deleted", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);

    const resolvedTime = "2026-07-18T13:00:00.000Z";
    let report = await addReportUpdate(created.id, {
      status: "resolved", markdown: "Fixed.", publishedAt: resolvedTime,
    }, deps);
    expect(report.resolvedAt).toBe(resolvedTime);
    expect(report.currentStatus).toBe("resolved");

    // Backdating the resolved update behind the investigating one flips the
    // report back to ongoing.
    const resolvedUpdate = report.updates.find((update) => update.status === "resolved")!;
    report = await editReportUpdate(created.id, resolvedUpdate.id, {
      publishedAt: "2026-07-18T11:00:00.000Z",
    }, deps);
    expect(report.resolvedAt).toBeNull();
    expect(report.currentStatus).toBe("investigating");

    // Moving it forward again resolves the report again.
    report = await editReportUpdate(created.id, resolvedUpdate.id, {
      publishedAt: "2026-07-18T14:00:00.000Z",
    }, deps);
    expect(report.resolvedAt).toBe("2026-07-18T14:00:00.000Z");

    // Deleting the resolving update reopens the report.
    report = await deleteReportUpdate(created.id, resolvedUpdate.id, deps);
    expect(report.resolvedAt).toBeNull();
    expect(report.updates).toHaveLength(1);
  });

  it("refuses to delete the last update with LAST_UPDATE", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    await expect(deleteReportUpdate(created.id, created.updates[0].id, deps))
      .rejects.toMatchObject({ code: "LAST_UPDATE" });
  });

  it("store contract: the guarded delete refuses the surviving update after a race", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    const report = await addReportUpdate(created.id, { status: "monitoring", markdown: "Watching." }, deps);
    const [first, second] = report.updates.map((update) => update.id);

    // Two deletes racing over a two-update report: exactly one wins; the
    // loser sees "last_update" (row exists, zero rows deleted), never a
    // report with no updates left.
    await expect(store.deleteUpdate({ reportId: created.id, updateId: first })).resolves.toBe("deleted");
    await expect(store.deleteUpdate({ reportId: created.id, updateId: second })).resolves.toBe("last_update");
    await expect(store.deleteUpdate({ reportId: created.id, updateId: first })).resolves.toBe("missing");
    expect([...store.updates.values()].filter((row) => row.reportId === created.id)).toHaveLength(1);

    // The service maps the guarded outcome even though the row still exists.
    await expect(deleteReportUpdate(created.id, second, deps)).rejects.toMatchObject({ code: "LAST_UPDATE" });
  });

  it("store contract: truly concurrent deletes of DIFFERENT updates never both succeed (finding: LAST_UPDATE race)", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    const report = await addReportUpdate(created.id, { status: "monitoring", markdown: "Watching." }, deps);
    const [first, second] = report.updates.map((update) => update.id);

    // Fired concurrently (not sequentially, unlike the test above); the
    // guarded contract must still hold: exactly one "deleted", exactly one
    // "last_update", and the report never ends up with zero updates. A
    // non-locking count-subquery implementation could let both observe
    // count=2 under READ COMMITTED and both report "deleted".
    const [firstOutcome, secondOutcome] = await Promise.all([
      store.deleteUpdate({ reportId: created.id, updateId: first }),
      store.deleteUpdate({ reportId: created.id, updateId: second }),
    ]);
    expect([firstOutcome, secondOutcome].sort()).toEqual(["deleted", "last_update"]);
    expect([...store.updates.values()].filter((row) => row.reportId === created.id)).toHaveLength(1);
  });

  it("serializes id, publishedAt, and createdAt on every update for the client-side tiebreak", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    expect(created.updates[0]).toMatchObject({
      id: expect.any(String),
      publishedAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
    });
    const report = await addReportUpdate(created.id, { status: "monitoring", markdown: "Watching." }, deps);
    for (const update of report.updates) {
      expect(update.createdAt).toBe(NOW.toISOString());
    }
  });

  it("maps a concurrent-delete race to REPORT_NOT_FOUND instead of crashing on a foreign-key violation (finding: getReport succeeding then a concurrent DELETE committing before the insert used to bubble a raw FK-violation 500)", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);

    // Simulate the report being deleted in the window between addReportUpdate's
    // existence check and the row-locked insert: the guarded store method
    // re-checks existence and finds the report gone, so it returns null
    // instead of ever attempting an insert against a missing report_id.
    const originalInsert = store.insertReportUpdate.bind(store);
    store.insertReportUpdate = async (input) => {
      await store.deleteReport(created.id);
      return originalInsert(input);
    };

    await expect(addReportUpdate(created.id, { status: "monitoring", markdown: "Watching." }, deps))
      .rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
    // The report (and, via cascade, its updates) is gone; nothing was
    // inserted for the raced attempt.
    expect([...store.updates.values()].filter((row) => row.reportId === created.id)).toHaveLength(0);
  });

  it("store contract: insertReportUpdate re-checks existence and inserts atomically, returning null (and inserting nothing) once the report is gone", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    await store.deleteReport(created.id);

    const result = await store.insertReportUpdate({
      reportId: created.id,
      update: {
        id: "orphan-update", reportId: created.id, status: "monitoring", markdown: "Watching.",
        publishedAt: NOW, createdAt: NOW, updatedAt: NOW,
      },
    });
    expect(result).toBeNull();
    expect(store.updates.has("orphan-update")).toBe(false);
  });

  it("reports UPDATE_NOT_FOUND and REPORT_NOT_FOUND distinctly", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    await expect(editReportUpdate(created.id, "missing", { status: "monitoring" }, deps))
      .rejects.toMatchObject({ code: "UPDATE_NOT_FOUND" });
    await expect(addReportUpdate("missing", { status: "monitoring", markdown: "x" }, deps))
      .rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
  });

  it("keeps resolvedAt consistent when two updates land concurrently on the same report (finding: an unlocked list-then-write recompute can race and persist a stale value)", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps); // investigating

    const [reportFromA, reportFromB] = await Promise.all([
      addReportUpdate(created.id, { status: "monitoring", markdown: "Watching." }, deps),
      addReportUpdate(created.id, {
        status: "resolved", markdown: "Fixed.", publishedAt: "2026-07-18T13:00:00.000Z",
      }, deps),
    ]);

    // Both responses, and the persisted row, must agree on the FINAL
    // state: three updates total, resolvedAt reflecting the resolved one.
    expect(reportFromA.updates).toHaveLength(3);
    expect(reportFromB.updates).toHaveLength(3);
    expect(store.reports.get(created.id)!.resolvedAt).toEqual(new Date("2026-07-18T13:00:00.000Z"));
  });

  it("store contract: recomputeResolution serializes concurrent calls on the same report to one consistent final snapshot (finding: resolvedAt lost-update race)", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    await store.insertUpdate({
      id: "upd-monitoring", reportId: created.id, status: "monitoring", markdown: "Watching.",
      publishedAt: new Date("2026-07-18T13:00:00.000Z"), createdAt: NOW, updatedAt: NOW,
    });
    await store.insertUpdate({
      id: "upd-resolved", reportId: created.id, status: "resolved", markdown: "Fixed.",
      publishedAt: new Date("2026-07-18T14:00:00.000Z"), createdAt: NOW, updatedAt: NOW,
    });

    // Two recomputes fired concurrently (as two racing mutations' tails
    // would) must both agree on the full, current update set rather than one
    // of them clobbering the other's write with a value derived from a
    // partial snapshot.
    const [first, second] = await Promise.all([
      store.recomputeResolution({ reportId: created.id, now: NOW }),
      store.recomputeResolution({ reportId: created.id, now: NOW }),
    ]);
    expect(first?.resolvedAt).toEqual(new Date("2026-07-18T14:00:00.000Z"));
    expect(second?.resolvedAt).toEqual(new Date("2026-07-18T14:00:00.000Z"));
    expect(first?.updates).toHaveLength(3);
    expect(second?.updates).toHaveLength(3);
    expect(store.reports.get(created.id)!.resolvedAt).toEqual(new Date("2026-07-18T14:00:00.000Z"));
  });
});

describe("updateStatusReport", () => {
  it("replaces the affected set with fresh snapshots", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    const report = await updateStatusReport(created.id, {
      title: "API outage (US)",
      affected: [{ monitorId: "web", impact: "degraded" }],
    }, deps);
    expect(report.title).toBe("API outage (US)");
    expect(report.affected).toEqual([
      { monitorId: "web", monitorName: "Website", groupName: null, impact: "degraded" },
    ]);
  });

  it("rejects empty patches and unknown reports", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    await expect(updateStatusReport("missing", {}, deps)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(updateStatusReport("missing", { title: "X" }, deps)).rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
  });

  it("validates a partial bound patch against the effective OTHER bound (finding: inverted windows via PATCH)", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport({
      ...validCreate, type: "maintenance", affected: [],
      startsAt: "2026-07-19T00:00:00.000Z", endsAt: "2026-07-19T02:00:00.000Z",
      update: { status: "scheduled", markdown: "Planned." },
    }, deps);

    // Moving startsAt PAST the existing (untouched) endsAt must be rejected.
    await expect(updateStatusReport(created.id, {
      startsAt: "2026-07-19T03:00:00.000Z",
    }, deps)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // Moving endsAt BEFORE the existing (untouched) startsAt must be rejected.
    await expect(updateStatusReport(created.id, {
      endsAt: "2026-07-18T23:00:00.000Z",
    }, deps)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // Either bound moving to a value that still keeps the window valid succeeds.
    await expect(updateStatusReport(created.id, {
      startsAt: "2026-07-19T01:00:00.000Z",
    }, deps)).resolves.toMatchObject({ startsAt: "2026-07-19T01:00:00.000Z" });
  });

  it("rejects a patch adding endsAt to an incident report (finding: incidents have no scheduled window)", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    await expect(updateStatusReport(created.id, {
      endsAt: "2026-07-19T00:00:00.000Z",
    }, deps)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // Clearing (explicit null) is a no-op, not a window, and still succeeds.
    await expect(updateStatusReport(created.id, { endsAt: null }, deps))
      .resolves.toMatchObject({ endsAt: null });

    // A maintenance report is unaffected; it may still set endsAt.
    const maintenance = await createStatusReport({
      ...validCreate, type: "maintenance", affected: [],
      startsAt: "2026-07-19T00:00:00.000Z",
      update: { status: "scheduled", markdown: "Planned." },
    }, deps);
    await expect(updateStatusReport(maintenance.id, {
      endsAt: "2026-07-19T02:00:00.000Z",
    }, deps)).resolves.toMatchObject({ endsAt: "2026-07-19T02:00:00.000Z" });
  });

  it("rejects a patch replacing affected with an impact that doesn't match the report type", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    await expect(updateStatusReport(created.id, {
      affected: [{ monitorId: "web", impact: "maintenance" }],
    }, deps)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const maintenance = await createStatusReport({
      ...validCreate, type: "maintenance", affected: [],
      update: { status: "scheduled", markdown: "Planned." },
    }, deps);
    await expect(updateStatusReport(maintenance.id, {
      affected: [{ monitorId: "web", impact: "down" }],
    }, deps)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("publishStatusReport", () => {
  it("publishes a draft exactly once and then conflicts", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const draft = await createStatusReport({ ...validCreate, draft: true }, deps);
    const published = await publishStatusReport(draft.id, deps);
    expect(published.publishedAt).toBe(NOW.toISOString());
    await expect(publishStatusReport(draft.id, deps)).rejects.toMatchObject({ code: "ALREADY_PUBLISHED" });
    await expect(publishStatusReport("missing", deps)).rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
  });
});

describe("recoverPublishedStatusReport (finding: publish shipped with no recover callback, so a committed-then-crashed publish replayed a false ALREADY_PUBLISHED 409 instead of its own success)", () => {
  it("recovers with the current report when it's published (a prior attempt committed the publish before crashing)", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const draft = await createStatusReport({ ...validCreate, draft: true }, deps);
    const published = await publishStatusReport(draft.id, deps);

    const recovered = await recoverPublishedStatusReport(draft.id, deps);
    expect(recovered).toEqual(published);
  });

  it("returns null when the report is still a draft (genuine crash before the publish committed)", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const draft = await createStatusReport({ ...validCreate, draft: true }, deps);
    await expect(recoverPublishedStatusReport(draft.id, deps)).resolves.toBeNull();
  });

  it("returns null for an unknown report", async () => {
    const store = memoryStore();
    await expect(recoverPublishedStatusReport("missing", dependencies(store))).resolves.toBeNull();
  });
});

describe("deleteStatusReport", () => {
  it("deletes and 404s afterwards", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    await expect(deleteStatusReport(created.id, deps)).resolves.toEqual({ id: created.id });
    await expect(getStatusReport(created.id, deps)).rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
    await expect(deleteStatusReport(created.id, deps)).rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
  });
});

describe("recoverDeletedStatusReport (finding: DELETE /status-reports/{id} shipped with no recover callback, so a committed-then-crashed delete replayed a false REPORT_NOT_FOUND 404 instead of its own success)", () => {
  it("recovers (true) when the report is gone (a prior attempt committed the delete before crashing)", async () => {
    const store = memoryStore();
    // A genuinely-existing report always has a UUID-shaped id in production
    // (the store's own isUuid guard rejects anything else), so this fixture
    // must be UUID-shaped too, unlike the file's default sequential ids;
    // otherwise the malformed-id short-circuit added below would swallow
    // this case for the wrong reason.
    const deps = { store, newId: sequentialUuids(), now: () => NOW };
    const created = await createStatusReport(validCreate, deps);
    await deleteStatusReport(created.id, deps);
    await expect(recoverDeletedStatusReport(created.id, deps)).resolves.toBe(true);
  });

  it("returns false when the report still exists (genuine crash before the delete committed)", async () => {
    const store = memoryStore();
    const deps = { store, newId: sequentialUuids(), now: () => NOW };
    const created = await createStatusReport(validCreate, deps);
    await expect(recoverDeletedStatusReport(created.id, deps)).resolves.toBe(false);
  });

  it("recovers (true) for a WELL-FORMED report id that never existed — accepted residual: indistinguishable from 'this recovery's own crashed delete already removed it' without a tombstone, and safe per DELETE's idempotent target-state semantics (RFC 9110 §9.3.5)", async () => {
    const store = memoryStore();
    await expect(recoverDeletedStatusReport("00000000-0000-4000-8000-000000000404", dependencies(store))).resolves.toBe(true);
  });

  it("returns false (does NOT recover) for a MALFORMED report id (finding: a malformed id can never have existed, so a genuine first-attempt crash against it is a real 404 — treating store.getReport's null return the same as 'already deleted' would replay a false 200 instead of letting work() record that real REPORT_NOT_FOUND)", async () => {
    const store = memoryStore();
    await expect(recoverDeletedStatusReport("not-a-uuid", dependencies(store))).resolves.toBe(false);
  });
});

describe("promoteIncident", () => {
  const openedAt = new Date("2026-07-18T09:30:00.000Z");

  function storeWithIncident(openingStatusCode: number | null = 503) {
    const store = memoryStore();
    store.incidents.set("inc-1", {
      id: "inc-1", monitorId: "api-prod", monitorName: "API (production)",
      groupName: "Core", openedAt, openingStatusCode,
    });
    return store;
  }

  it("prefills a draft from the incident with snapshots and the sanitized cause", async () => {
    const store = storeWithIncident(503);
    const { report, created } = await promoteIncident("inc-1", dependencies(store));
    expect(created).toBe(true);
    expect(report.publishedAt).toBeNull();
    expect(report.type).toBe("incident");
    expect(report.title).toBe("API (production) outage");
    expect(report.startsAt).toBe(openedAt.toISOString());
    expect(report.originIncidentId).toBe("inc-1");
    expect(report.affected).toEqual([
      { monitorId: "api-prod", monitorName: "API (production)", groupName: "Core", impact: "down" },
    ]);
    expect(report.currentStatus).toBe("investigating");
    expect(report.updates[0].markdown).toContain("HTTP 503");
    expect(report.updates[0].markdown).not.toContain("ECONNREFUSED");
  });

  it("sanitizes checker error codes to the public label", async () => {
    const store = storeWithIncident(null);
    const { report } = await promoteIncident("inc-1", dependencies(store));
    expect(report.updates[0].markdown).toContain("Availability check failed");
    expect(publicIncidentCause(null)).toBe("Availability check failed");
    expect(publicIncidentCause(502)).toBe("HTTP 502");
  });

  it("is idempotent: promoting again returns the existing report", async () => {
    const store = storeWithIncident();
    const deps = dependencies(store);
    const first = await promoteIncident("inc-1", deps);
    const second = await promoteIncident("inc-1", deps);
    expect(second.created).toBe(false);
    expect(second.report.id).toBe(first.report.id);
    expect(store.reports.size).toBe(1);
  });

  it("404s for unknown incidents", async () => {
    const store = memoryStore();
    await expect(promoteIncident("missing", dependencies(store)))
      .rejects.toMatchObject({ code: "INCIDENT_NOT_FOUND" });
  });

  it("pins the new report's id to dependencies.reportId instead of drawing one from newId() (mirrors createStatusReport: the route sets this to the idempotency operationId so a retry after a crash mid-request can recover the row by id)", async () => {
    const store = storeWithIncident();
    const { report, created } = await promoteIncident("inc-1", { ...dependencies(store), reportId: "op-pinned" });
    expect(created).toBe(true);
    expect(report.id).toBe("op-pinned");
    expect(report.affected[0]).toMatchObject({ monitorId: "api-prod" });
    expect(store.reports.get("op-pinned")).toBeDefined();
    expect([...store.updates.values()].some((row) => row.reportId === "op-pinned")).toBe(true);
  });

  describe("recoverPromotedReport (finding: promote shipped with no recover callback; promoteIncident is already safe to rerun via the partial unique index, but recovery lets a retry short-circuit at the database instead of re-validating the incident and re-serializing fresh values)", () => {
    it("recovers with the existing report tied to this incident (created:false semantics, mirroring a promote conflict)", async () => {
      const store = storeWithIncident();
      const deps = dependencies(store);
      const { report: promoted } = await promoteIncident("inc-1", deps);

      const recovered = await recoverPromotedReport("inc-1", deps);
      expect(recovered).toEqual(promoted);
    });

    it("returns null when no report exists yet for this incident (genuine crash before the create committed)", async () => {
      const store = storeWithIncident();
      await expect(recoverPromotedReport("inc-1", dependencies(store))).resolves.toBeNull();
    });

    it("returns null for an unrelated/unknown incident id", async () => {
      const store = memoryStore();
      await expect(recoverPromotedReport("missing", dependencies(store))).resolves.toBeNull();
    });
  });
});

describe("listStatusReports", () => {
  it("filters state and type separately and paginates with a stable cursor", async () => {
    const store = memoryStore();
    const newId = sequentialUuids();
    let tick = 0;
    const deps = { store, newId, now: () => new Date(NOW.getTime() + (tick += 1_000)) };
    const draft = await createStatusReport({ ...validCreate, draft: true }, deps);
    const published = await createStatusReport({ ...validCreate, title: "Second" }, deps);
    const maintenance = await createStatusReport({
      type: "maintenance", title: "DB upgrade",
      update: { status: "scheduled", markdown: "Planned." },
    }, deps);

    const drafts = await listStatusReports({ state: "draft", type: "all", cursor: null, limit: 50 }, deps);
    expect(drafts.data.map((row) => row.id)).toEqual([draft.id]);

    const maintenanceOnly = await listStatusReports({ state: "all", type: "maintenance", cursor: null, limit: 50 }, deps);
    expect(maintenanceOnly.data.map((row) => row.id)).toEqual([maintenance.id]);

    const pageOne = await listStatusReports({ state: "all", type: "all", cursor: null, limit: 2 }, deps);
    expect(pageOne.data).toHaveLength(2);
    expect(pageOne.nextCursor).not.toBeNull();
    const cursor = parseStatusReportListQuery({ state: null, type: null, cursor: pageOne.nextCursor }).cursor;
    const pageTwo = await listStatusReports({ state: "all", type: "all", cursor, limit: 2 }, deps);
    expect(pageTwo.data.map((row) => row.id)).toEqual([draft.id]);
    expect(pageTwo.nextCursor).toBeNull();
    expect(pageOne.data.map((row) => row.id)).toEqual([maintenance.id, published.id]);
  });

  it("summarizes list rows without markdown bodies or full update timelines", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    await addReportUpdate(created.id, {
      status: "monitoring", markdown: "A fix is deployed.", publishedAt: "2026-07-18T13:00:00.000Z",
    }, deps);

    const { data, nextCursor } = await listStatusReportSummaries(
      { state: "all", type: "all", cursor: null, limit: 50 },
      deps,
    );
    expect(nextCursor).toBeNull();
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      id: created.id,
      currentStatus: "monitoring",
      updatesCount: 2,
      latestUpdate: { status: "monitoring", publishedAt: "2026-07-18T13:00:00.000Z" },
      affected: [{ monitorId: "api-prod", monitorName: "API (production)", groupName: "Core", impact: "down" }],
    });
    expect(JSON.stringify(data)).not.toContain("markdown");
    expect(JSON.stringify(data)).not.toContain("A fix is deployed.");
  });

  it("paginates summaries with the same stable cursor as the detailed list", async () => {
    const store = memoryStore();
    const newId = sequentialUuids();
    let tick = 0;
    const deps = { store, newId, now: () => new Date(NOW.getTime() + (tick += 1_000)) };
    await createStatusReport(validCreate, deps);
    const second = await createStatusReport({ ...validCreate, title: "Second" }, deps);
    const third = await createStatusReport({ ...validCreate, title: "Third" }, deps);

    const pageOne = await listStatusReportSummaries({ state: "all", type: "all", cursor: null, limit: 2 }, deps);
    expect(pageOne.data.map((row) => row.id)).toEqual([third.id, second.id]);
    expect(pageOne.nextCursor).not.toBeNull();
    const cursor = parseStatusReportListQuery({ state: null, type: null, cursor: pageOne.nextCursor }).cursor;
    const pageTwo = await listStatusReportSummaries({ state: "all", type: "all", cursor, limit: 2 }, deps);
    expect(pageTwo.data).toHaveLength(1);
    expect(pageTwo.nextCursor).toBeNull();
  });

  it("rejects invalid filters and cursors", () => {
    expect(() => parseStatusReportListQuery({ state: "open", type: null, cursor: null }))
      .toThrow(StatusReportError);
    expect(() => parseStatusReportListQuery({ state: null, type: "outage", cursor: null }))
      .toThrow(StatusReportError);
    expect(() => parseStatusReportListQuery({ state: null, type: null, cursor: "not-a-cursor" }))
      .toThrow(StatusReportError);
  });

  it("rejects a well-formed cursor carrying a non-UUID id as INVALID_CURSOR instead of reaching Postgres (finding: 22P02)", () => {
    const crafted = encodeCursor({ sort: NOW.toISOString(), id: "'; drop table status_reports;--" });
    expect(() => parseStatusReportListQuery({ state: null, type: null, cursor: crafted }))
      .toThrow(StatusReportError);
    try {
      parseStatusReportListQuery({ state: null, type: null, cursor: crafted });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_CURSOR" });
    }
    // A well-formed cursor with a genuine UUID id still parses.
    const valid = encodeCursor({ sort: NOW.toISOString(), id: "11111111-1111-4111-8111-111111111111" });
    expect(parseStatusReportListQuery({ state: null, type: null, cursor: valid }).cursor).toEqual({
      createdAt: NOW, id: "11111111-1111-4111-8111-111111111111",
    });
  });
});

describe("database store UUID guards", () => {
  // db is mocked as {} in this file: if any of these touched Postgres the call
  // would throw. Non-UUID route params must short-circuit to the "not found"
  // shape instead of reaching a uuid-typed comparison (Postgres 22P02 → 500).
  it("returns not-found shapes for non-UUID identifiers without touching the database", async () => {
    await expect(databaseStatusReportsStore.getReport("not-a-uuid")).resolves.toBeNull();
    await expect(databaseStatusReportsStore.getReport("<script>alert(1)</script>")).resolves.toBeNull();
    await expect(databaseStatusReportsStore.findIncident("inc_9")).resolves.toBeNull();
    await expect(databaseStatusReportsStore.deleteReport("rep_1")).resolves.toBe(false);
    await expect(databaseStatusReportsStore.publishReport({ id: "rep_1", now: NOW })).resolves.toBe("missing");
    await expect(databaseStatusReportsStore.editUpdate({
      reportId: "11111111-1111-4111-8111-111111111111", updateId: "upd_1", patch: {}, now: NOW,
    })).resolves.toBeNull();
    await expect(databaseStatusReportsStore.deleteUpdate({
      reportId: "rep_1", updateId: "11111111-1111-4111-8111-111111111111",
    })).resolves.toBe("missing");
    await expect(databaseStatusReportsStore.getUpdate("rep_1", "11111111-1111-4111-8111-111111111111"))
      .resolves.toBeNull();
    await expect(databaseStatusReportsStore.recomputeResolution({ reportId: "rep_1", now: NOW })).resolves.toBeNull();
  });

  it("maps guarded non-UUID lookups to the existing 404 error codes", async () => {
    await expect(getStatusReport("not-a-uuid")).rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
    await expect(promoteIncident("inc_9")).rejects.toMatchObject({ code: "INCIDENT_NOT_FOUND" });
  });
});

describe("idempotent-create recovery (finding: duplicate report/update after a crash)", () => {
  it("pins the report id to a caller-supplied reportId and recovers it by that id", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, { ...deps, reportId: "op-report-1" });
    expect(created.id).toBe("op-report-1");

    const recovered = await recoverCreatedStatusReport("op-report-1", deps);
    expect(recovered).toEqual(created);
  });

  it("returns null when recovering an id nothing ever created", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    await expect(recoverCreatedStatusReport("never-created", deps)).resolves.toBeNull();
  });

  it("pins the update id to a caller-supplied updateId and recovers the report by it", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    const updated = await addReportUpdate(created.id, {
      status: "monitoring", markdown: "Watching.",
    }, { ...deps, updateId: "op-update-1" });
    expect(updated.updates.some((update) => update.id === "op-update-1")).toBe(true);

    const recovered = await recoverAddedReportUpdate(created.id, "op-update-1", deps);
    expect(recovered).toEqual(updated);
  });

  it("returns null recovering an update id that was never added, or on an unknown report", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    await expect(recoverAddedReportUpdate(created.id, "never-added", deps)).resolves.toBeNull();
    await expect(recoverAddedReportUpdate("missing-report", "never-added", deps)).resolves.toBeNull();
  });

  it("recomputes and persists resolution on recovery (finding: crash between insert and the resolution recompute leaves a stale resolvedAt)", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);

    // Simulate the insert having committed but the process dying before
    // persistResolutionAndSerialize's recompute ran: the update row exists,
    // but the report's resolvedAt is still the stale pre-update null.
    await store.insertUpdate({
      id: "op-update-1", reportId: created.id, status: "resolved", markdown: "Fixed.",
      publishedAt: NOW, createdAt: NOW, updatedAt: NOW,
    });
    expect(store.reports.get(created.id)!.resolvedAt).toBeNull();

    const recovered = await recoverAddedReportUpdate(created.id, "op-update-1", deps);
    expect(recovered?.resolvedAt).toBe(NOW.toISOString());
    expect(recovered?.currentStatus).toBe("resolved");
    // The recompute is persisted, not just reflected in the response.
    expect(store.reports.get(created.id)!.resolvedAt).toEqual(NOW);
  });

  it("recovers by a direct point lookup (getUpdate) rather than scanning capped detail rows (finding: a backdated update beyond the 500-row detail cap would never surface in a getReportDetails scan)", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    const getReportDetailsSpy = vi.spyOn(store, "getReportDetails");

    const updated = await addReportUpdate(created.id, {
      status: "monitoring", markdown: "Watching.",
    }, { ...deps, updateId: "op-update-1" });
    getReportDetailsSpy.mockClear();

    const recovered = await recoverAddedReportUpdate(created.id, "op-update-1", deps);
    expect(recovered).toEqual(updated);
    expect(getReportDetailsSpy).not.toHaveBeenCalled();
  });
});

describe("idempotent-edit recovery (finding: PATCH /updates/{updateId} was the only mutation in this family shipped without a recover callback)", () => {
  it("recovers by serializing current state when the update's fields already match the requested patch", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    const updateId = created.updates[0].id;

    // Simulate the edit having committed (and resolution recomputed) but the
    // process dying before the idempotency record completed.
    const edited = await editReportUpdate(created.id, updateId, { status: "monitoring", markdown: "Watching." }, deps);

    const recovered = await recoverEditedReportUpdate(created.id, updateId, { status: "monitoring", markdown: "Watching." }, deps);
    expect(recovered).toEqual(edited);
  });

  it("only compares fields the caller actually sent", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    const updateId = created.updates[0].id;
    const edited = await editReportUpdate(created.id, updateId, { status: "monitoring" }, deps);

    // markdown wasn't part of the patch, so it must not be compared even
    // though it (obviously) still matches the original, untouched value.
    const recovered = await recoverEditedReportUpdate(created.id, updateId, { status: "monitoring" }, deps);
    expect(recovered).toEqual(edited);
  });

  it("returns null when the current state genuinely differs from the requested patch (crash before the edit committed)", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    const updateId = created.updates[0].id;
    await expect(recoverEditedReportUpdate(created.id, updateId, { status: "monitoring" }, deps)).resolves.toBeNull();
  });

  it("returns null for an unknown report or update", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    await expect(recoverEditedReportUpdate("missing-report", "missing-update", { status: "monitoring" }, deps)).resolves.toBeNull();
    await expect(recoverEditedReportUpdate(created.id, "missing-update", { status: "monitoring" }, deps)).resolves.toBeNull();
  });

  it("returns null for an INVALID patch body (finding: {} or unsupported-key bodies fell through to true since no recognized field mismatched, recovering a stale retry of a genuine VALIDATION_ERROR as a false 200)", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    const updateId = created.updates[0].id;
    await expect(recoverEditedReportUpdate(created.id, updateId, {}, deps)).resolves.toBeNull();
    await expect(recoverEditedReportUpdate(created.id, updateId, { foo: 1 }, deps)).resolves.toBeNull();
  });
});

describe("recoverDeletedReportUpdate (finding: DELETE /updates/{updateId} shipped with no recover callback, so a committed-then-crashed delete replayed a false UPDATE_NOT_FOUND 404 instead of its own success)", () => {
  it("recovers by recomputing+serializing current state when the update is gone but the report still exists", async () => {
    const store = memoryStore();
    // UUID-shaped ids, matching production (the store's own isUuid guard
    // rejects anything else), unlike the file's default sequential ids,
    // which would otherwise trip the malformed-id short-circuit added below
    // for the wrong reason.
    const deps = { store, newId: sequentialUuids(), now: () => NOW };
    const created = await createStatusReport(validCreate, deps);
    const second = await addReportUpdate(created.id, { status: "monitoring", markdown: "Watching." }, deps);
    const updateId = second.updates.find((update) => update.status === "monitoring")!.id;

    // Simulate the delete having committed before a crash.
    const deleted = await deleteReportUpdate(created.id, updateId, deps);

    const recovered = await recoverDeletedReportUpdate(created.id, updateId, deps);
    expect(recovered).toEqual(deleted);
  });

  it("returns null when the update still exists (genuine crash before the delete committed)", async () => {
    const store = memoryStore();
    const deps = { store, newId: sequentialUuids(), now: () => NOW };
    const created = await createStatusReport(validCreate, deps);
    await addReportUpdate(created.id, { status: "monitoring", markdown: "Watching." }, deps);
    const updateId = created.updates[0].id;
    await expect(recoverDeletedReportUpdate(created.id, updateId, deps)).resolves.toBeNull();
  });

  it("returns null for an unknown report (can't recompute+serialize without it; work() reruns and records the truthful current REPORT_NOT_FOUND)", async () => {
    const store = memoryStore();
    await expect(recoverDeletedReportUpdate("missing-report", "missing-update", dependencies(store))).resolves.toBeNull();
  });

  it("recovers (success) for a WELL-FORMED update id that never existed on a report that still does — accepted residual: indistinguishable from, and safe per the same guarded-delete/DELETE-is-idempotent invariant as, recoverDeletedStatusReport's 'gone is gone' semantics", async () => {
    const store = memoryStore();
    const deps = { store, newId: sequentialUuids(), now: () => NOW };
    const created = await createStatusReport(validCreate, deps);
    const recovered = await recoverDeletedReportUpdate(created.id, "00000000-0000-4000-8000-000000000404", deps);
    expect(recovered?.id).toBe(created.id);
    expect(recovered?.updates).toEqual(created.updates);
  });

  it("returns null (does NOT recover) for a MALFORMED update id on a report that still exists (finding: a malformed id can never have existed, so a genuine first-attempt crash against it is a real 404 — treating store.getUpdate's null return the same as 'already deleted' would replay a false 200 instead of letting work() record that real UPDATE_NOT_FOUND)", async () => {
    const store = memoryStore();
    const deps = { store, newId: sequentialUuids(), now: () => NOW };
    const created = await createStatusReport(validCreate, deps);
    await expect(recoverDeletedReportUpdate(created.id, "not-a-uuid", deps)).resolves.toBeNull();
  });
});

describe("affected-row read caps derive from the page, not a fixed constant (finding: 2,000-row truncation)", () => {
  it("MAX_AFFECTED_PER_REPORT matches the per-report write-time cap", () => {
    // affectedListSchema.max(...) uses the same constant, so a page's affected
    // read cap (reportIds.length * MAX_AFFECTED_PER_REPORT) can never truncate
    // a set of reports that are each individually within the write-time bound.
    expect(MAX_AFFECTED_PER_REPORT).toBe(100);
  });
});

describe("getPublicReports", () => {
  it("excludes drafts even when the store returns them", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    await createStatusReport({ ...validCreate, draft: true }, deps);
    const published = await createStatusReport({ ...validCreate, title: "Public one" }, deps);
    const result = await getPublicReports(deps);
    expect(result.ongoing.map((row) => row.id)).toEqual([published.id]);
    expect(result.upcoming).toEqual([]);
    expect(result.resolved).toEqual([]);
  });

  it("classifies maintenance as upcoming, ongoing, and window-ended per the lifecycle rules", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const upcoming = await createStatusReport({
      type: "maintenance", title: "Future window",
      startsAt: "2026-07-19T00:00:00.000Z", endsAt: "2026-07-19T02:00:00.000Z",
      update: { status: "scheduled", markdown: "Planned." },
    }, deps);
    const ongoing = await createStatusReport({
      type: "maintenance", title: "Active window",
      startsAt: "2026-07-18T11:00:00.000Z", endsAt: "2026-07-18T15:00:00.000Z",
      update: { status: "in_progress", markdown: "Underway." },
    }, deps);
    const stale = await createStatusReport({
      type: "maintenance", title: "Overran window",
      startsAt: "2026-07-18T08:00:00.000Z", endsAt: "2026-07-18T09:00:00.000Z",
      update: { status: "in_progress", markdown: "Never closed." },
    }, deps);

    const result = await getPublicReports(deps);
    expect(result.upcoming.map((row) => row.id)).toEqual([upcoming.id]);
    expect(result.ongoing.map((row) => row.id)).toEqual([ongoing.id]);
    expect(result.windowEnded.map((row) => row.id)).toEqual([stale.id]);
    expect(result.ongoing[0].latestUpdate?.status).toBe("in_progress");
  });

  it("classifies a started-but-still-scheduled maintenance window as ongoing, matching the SQL active-bucket ranking (finding: classification vs SQL cap mismatch)", () => {
    // startsAt is already in the past relative to NOW: the window has
    // started even though the operator never posted an in_progress update,
    // so it must not sit in "upcoming" while getPublicReportRows ranks the
    // same row as active.
    const report = {
      type: "maintenance" as const,
      startsAt: new Date("2026-07-18T11:00:00.000Z"),
      endsAt: null,
      resolvedAt: null,
    };
    expect(classifyPublicReport(report, NOW)).toBe("ongoing");
  });

  it("still classifies a future-scheduled window as upcoming (startsAt has not arrived yet)", () => {
    const report = {
      type: "maintenance" as const,
      startsAt: new Date("2026-07-19T00:00:00.000Z"),
      endsAt: null,
      resolvedAt: null,
    };
    expect(classifyPublicReport(report, NOW)).toBe("upcoming");
  });

  it("classifies a future-dated incident report as upcoming, not ongoing (finding: future incidents leaked into the ongoing banner)", () => {
    const futureIncident = {
      type: "incident" as const,
      startsAt: new Date("2026-07-19T00:00:00.000Z"),
      endsAt: null,
      resolvedAt: null,
    };
    expect(classifyPublicReport(futureIncident, NOW)).toBe("upcoming");
    // A past-starting incident is unaffected and still classifies as ongoing.
    const pastIncident = { ...futureIncident, startsAt: new Date("2026-07-18T00:00:00.000Z") };
    expect(classifyPublicReport(pastIncident, NOW)).toBe("ongoing");
  });

  it("returns resolved reports with resolution recency ordering", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    await addReportUpdate(created.id, {
      status: "resolved", markdown: "Done.", publishedAt: "2026-07-18T13:00:00.000Z",
    }, deps);
    const result = await getPublicReports(deps);
    expect(result.ongoing).toEqual([]);
    expect(result.resolved.map((row) => row.id)).toEqual([created.id]);
    expect(result.resolved[0].phase).toBe("resolved");
    expect(result.resolved[0].resolvedAt).toBe("2026-07-18T13:00:00.000Z");
  });

  it("keeps an active report inside the unresolved cap even behind 100 future-scheduled windows (finding: active reports starved by future maintenance)", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const active = await createStatusReport({
      type: "maintenance", title: "Active window",
      startsAt: "2026-07-18T11:00:00.000Z", endsAt: "2026-07-18T15:00:00.000Z",
      update: { status: "in_progress", markdown: "Underway." },
    }, deps);
    for (let index = 0; index < 100; index += 1) {
      await createStatusReport({
        type: "maintenance", title: `Future window ${index}`,
        startsAt: `2027-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
        update: { status: "scheduled", markdown: "Planned." },
      }, deps);
    }
    const result = await getPublicReports(deps);
    expect(result.ongoing.map((row) => row.id)).toContain(active.id);
  });

  it("keeps the NEAREST future rows inside the unresolved cap, not the farthest (finding: future rows sorted farthest-first, starving the soonest upcoming report)", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const active = await createStatusReport({
      type: "maintenance", title: "Active window",
      startsAt: "2026-07-18T11:00:00.000Z", endsAt: "2026-07-18T15:00:00.000Z",
      update: { status: "in_progress", markdown: "Underway." },
    }, deps);
    // 150 future rows, one minute apart, in ascending startsAt order; only
    // 99 fit in the unresolved cap alongside the 1 active row.
    const base = new Date("2027-01-01T00:00:00.000Z").getTime();
    const future: Awaited<ReturnType<typeof createStatusReport>>[] = [];
    for (let index = 0; index < 150; index += 1) {
      future.push(await createStatusReport({
        type: "maintenance", title: `Future window ${index}`,
        startsAt: new Date(base + index * 60_000).toISOString(),
        update: { status: "scheduled", markdown: "Planned." },
      }, deps));
    }
    const result = await getPublicReports(deps);
    expect(result.ongoing.map((row) => row.id)).toContain(active.id);
    expect(result.upcoming).toHaveLength(99);
    // The NEAREST future rows (smallest startsAt) must survive the cap...
    expect(result.upcoming.map((row) => row.id)).toContain(future[0].id);
    expect(result.upcoming.map((row) => row.id)).toContain(future[98].id);
    // ...while the FARTHEST rows are the ones dropped.
    expect(result.upcoming.map((row) => row.id)).not.toContain(future[149].id);
  });

  it("classifies a published future-dated incident as upcoming, not ongoing (finding: future incidents fed the ongoing banner)", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const futureIncident = await createStatusReport({
      ...validCreate, title: "Planned failover drill",
      startsAt: "2026-07-19T00:00:00.000Z",
      update: { status: "investigating", markdown: "Scheduled." },
    }, deps);
    const result = await getPublicReports(deps);
    expect(result.upcoming.map((row) => row.id)).toEqual([futureIncident.id]);
    expect(result.ongoing).toEqual([]);
  });

  it("keeps an active report inside the unresolved cap even behind 100 ended-but-uncompleted maintenance windows (finding: stale ended windows crowding active reports)", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    // Started well before the 100 stale windows below, but genuinely still
    // active (no endsAt): must not be pushed off the cap by
    // more-recently-started rows.
    const active = await createStatusReport({
      ...validCreate, title: "Active incident",
      startsAt: "2026-07-10T00:00:00.000Z",
      update: { status: "investigating", markdown: "Ongoing." },
    }, deps);
    for (let index = 0; index < 100; index += 1) {
      await createStatusReport({
        type: "maintenance", title: `Overran window ${index}`,
        startsAt: `2026-07-18T${String(index % 10).padStart(2, "0")}:00:00.000Z`,
        endsAt: "2026-07-18T11:00:00.000Z",
        update: { status: "in_progress", markdown: "Never closed." },
      }, deps);
    }
    const result = await getPublicReports(deps);
    expect(result.ongoing.map((row) => row.id)).toContain(active.id);
    expect(result.windowEnded).toHaveLength(99);
  });

  it("scopes the resolved LIMIT to a group filter so an older group-relevant report isn't starved by unrelated global history", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    // 10 unrelated (web / "Other" group) resolved reports fill the global top 10.
    for (let index = 0; index < 10; index += 1) {
      const report = await createStatusReport({
        ...validCreate, title: `Other resolved ${index}`,
        affected: [{ monitorId: "web", impact: "down" }],
      }, deps);
      await addReportUpdate(report.id, {
        status: "resolved", markdown: "Done.", publishedAt: `2026-07-18T${13 + index}:00:00.000Z`,
      }, deps);
    }
    // An older resolved report for "Core" (api-prod) would be pushed off the
    // global top 10 by the fresher "Other" reports above. Resolved just after
    // the report's own initial (NOW) update so it actually becomes the latest
    // update by the total order, but still older than every "Other" report's
    // resolution so it is the one the unfiltered top-10 would drop.
    const coreReport = await createStatusReport(validCreate, deps);
    await addReportUpdate(coreReport.id, {
      status: "resolved", markdown: "Done.", publishedAt: "2026-07-18T12:30:00.000Z",
    }, deps);

    const unfiltered = await getPublicReports(deps);
    expect(unfiltered.resolved.map((row) => row.id)).not.toContain(coreReport.id);

    const filtered = await getPublicReports(deps, { monitorIds: ["api-prod"], groupNames: ["Core"] });
    expect(filtered.resolved.map((row) => row.id)).toEqual([coreReport.id]);
  });
});
