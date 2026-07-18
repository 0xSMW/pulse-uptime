import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db: {} }));

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
  parseStatusReportListQuery,
  promoteIncident,
  publicIncidentCause,
  publishStatusReport,
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
    async listUpdates(reportId) {
      return [...updates.values()].filter((row) => row.reportId === reportId).map((row) => ({ ...row }));
    },
    async setResolution({ reportId, resolvedAt, now }) {
      const row = reports.get(reportId);
      if (row) Object.assign(row, { resolvedAt, updatedAt: now });
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
    async getPublicReportRows({ resolvedLimit }) {
      // Deliberately sloppier than the SQL (includes drafts) so the service's
      // own draft filter is exercised.
      const rows = [...reports.values()];
      const unresolved = rows.filter((row) => row.resolvedAt === null);
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
  };
  return store;
}

function sequentialIds(prefix: string) {
  let counter = 0;
  return () => `${prefix}-${String(++counter).padStart(4, "0")}`;
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

  it("reports UPDATE_NOT_FOUND and REPORT_NOT_FOUND distinctly", async () => {
    const store = memoryStore();
    const deps = dependencies(store);
    const created = await createStatusReport(validCreate, deps);
    await expect(editReportUpdate(created.id, "missing", { status: "monitoring" }, deps))
      .rejects.toMatchObject({ code: "UPDATE_NOT_FOUND" });
    await expect(addReportUpdate("missing", { status: "monitoring", markdown: "x" }, deps))
      .rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
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
});

describe("listStatusReports", () => {
  it("filters state and type separately and paginates with a stable cursor", async () => {
    const store = memoryStore();
    const newId = sequentialIds("rep");
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
    const newId = sequentialIds("rep");
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
  });

  it("maps guarded non-UUID lookups to the existing 404 error codes", async () => {
    await expect(getStatusReport("not-a-uuid")).rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
    await expect(promoteIncident("inc_9")).rejects.toMatchObject({ code: "INCIDENT_NOT_FOUND" });
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

  it("never places a scheduled-status window in the ongoing section", () => {
    const report = {
      type: "maintenance" as const,
      startsAt: new Date("2026-07-18T11:00:00.000Z"),
      endsAt: null,
      resolvedAt: null,
    };
    expect(classifyPublicReport(report, "scheduled", NOW)).toBe("upcoming");
    expect(classifyPublicReport(report, "in_progress", NOW)).toBe("ongoing");
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
});
