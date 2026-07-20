import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { dbMock } = vi.hoisted(() => ({ dbMock: { select: vi.fn() } }));
vi.mock("@/lib/db/client", () => ({ db: dbMock }));

vi.mock("@/lib/api/status-page-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/status-page-config")>();
  return { ...actual, getStatusPageConfig: vi.fn() };
});

vi.mock("@/lib/api/status-reports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/status-reports")>();
  return { ...actual, getPublicReports: vi.fn(), getStatusReport: vi.fn() };
});

vi.mock("@/lib/api/images", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/images")>();
  return { ...actual, getImage: vi.fn() };
});

import { getImage } from "@/lib/api/images";
import { getStatusPageConfig, StatusPageConfigError } from "@/lib/api/status-page-config";
import { getPublicReports, getStatusReport, StatusReportError } from "@/lib/api/status-reports";
import { defaultStatusPageDocument } from "@/lib/status-page/display";

import {
  getPublicReportDetail,
  getPublicStatus,
  getStatusFaviconDataUri,
  getStatusPageDisplayConfig,
  groupByMonitorId,
} from "./status";

/** Mimics a raw Node network error (e.g. from postgres.js's socket handling). */
function connectionError(code: string): Error {
  return Object.assign(new Error(`connect ${code} 127.0.0.1:5432`), { code });
}

/** A chainable stand-in for a drizzle `db.select(...).from(...)....limit(...)` call. */
function selectChain(outcome: unknown[] | Error) {
  const promise = outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  const node = {
    from: () => node,
    leftJoin: () => node,
    innerJoin: () => node,
    where: () => node,
    orderBy: () => node,
    limit: () => promise,
  };
  return node;
}

function resolvedConfig() {
  const document = defaultStatusPageDocument();
  return { data: { ...document, updatedAt: null, version: 0 }, etag: '"0"' };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.select.mockReset();
  // Default: no rows anywhere, no reports. Success path, empty status.
  dbMock.select.mockReturnValue(selectChain([]));
  vi.mocked(getPublicReports).mockResolvedValue({ ongoing: [], upcoming: [], windowEnded: [], resolved: [] });
});

describe("getStatusPageDisplayConfig", () => {
  it("degrades to the defaults document when the store throws an ECONNREFUSED-shaped error", async () => {
    vi.mocked(getStatusPageConfig).mockRejectedValue(connectionError("ECONNREFUSED"));
    const config = await getStatusPageDisplayConfig();
    expect(config).toEqual(defaultStatusPageDocument());
  });

  it("degrades to the defaults document on a Postgres undefined-table SQLSTATE (unapplied migrations)", async () => {
    vi.mocked(getStatusPageConfig).mockRejectedValue(
      Object.assign(new Error("relation \"status_page_config\" does not exist"), { code: "42P01" }),
    );
    const config = await getStatusPageDisplayConfig();
    expect(config).toEqual(defaultStatusPageDocument());
  });

  it("still degrades to defaults on the historical CONFIG_UNAVAILABLE (missing row) path", async () => {
    vi.mocked(getStatusPageConfig).mockRejectedValue(
      new StatusPageConfigError("CONFIG_UNAVAILABLE", "row missing"),
    );
    const config = await getStatusPageDisplayConfig();
    expect(config).toEqual(defaultStatusPageDocument());
  });

  it("rethrows a plain app error instead of degrading", async () => {
    vi.mocked(getStatusPageConfig).mockRejectedValue(new TypeError("Cannot read properties of undefined"));
    await expect(getStatusPageDisplayConfig()).rejects.toThrow(TypeError);
  });
});

describe("getStatusFaviconDataUri", () => {
  it("returns null when the image lookup throws an unavailable-classified error", async () => {
    vi.mocked(getStatusPageConfig).mockResolvedValue({
      ...resolvedConfig(),
      data: { ...resolvedConfig().data, faviconImageId: "11111111-1111-4111-8111-111111111111" },
    });
    vi.mocked(getImage).mockRejectedValue(connectionError("ETIMEDOUT"));
    await expect(getStatusFaviconDataUri()).resolves.toBeNull();
  });

  it("rethrows a plain app error from the image lookup", async () => {
    vi.mocked(getStatusPageConfig).mockResolvedValue({
      ...resolvedConfig(),
      data: { ...resolvedConfig().data, faviconImageId: "11111111-1111-4111-8111-111111111111" },
    });
    vi.mocked(getImage).mockRejectedValue(new TypeError("boom"));
    await expect(getStatusFaviconDataUri()).rejects.toThrow(TypeError);
  });
});

describe("getPublicStatus", () => {
  it("returns a degraded payload (unavailable, empty groups/reports, empty overall state) on an ECONNREFUSED-shaped error", async () => {
    vi.mocked(getStatusPageConfig).mockRejectedValue(connectionError("ECONNREFUSED"));
    dbMock.select.mockReturnValue(selectChain(connectionError("ECONNREFUSED")));

    const data = await getPublicStatus();

    expect(data).not.toBeNull();
    expect(data!.unavailable).toBe(true);
    expect(data!.overallState).toBe("empty");
    expect(data!.groups).toEqual([]);
    expect(data!.currentIncidents).toEqual([]);
    expect(data!.recentIncidents).toEqual([]);
    expect(data!.reports).toEqual({ ongoing: [], upcoming: [], windowEnded: [], resolved: [] });
    expect(data!.config).toMatchObject({ layout: "vertical", theme: "system", historyDays: 90 });
  });

  it("degrades on a Postgres auth failure (SQLSTATE 28P01) from the monitors query", async () => {
    vi.mocked(getStatusPageConfig).mockResolvedValue(resolvedConfig());
    dbMock.select.mockReturnValue(
      selectChain(Object.assign(new Error("password authentication failed"), { code: "28P01" })),
    );
    const data = await getPublicStatus();
    expect(data!.unavailable).toBe(true);
  });

  it("does NOT degrade — and does not 404 — a specific group when the database is unavailable", async () => {
    vi.mocked(getStatusPageConfig).mockRejectedValue(connectionError("ECONNREFUSED"));
    dbMock.select.mockReturnValue(selectChain(connectionError("ECONNREFUSED")));

    const data = await getPublicStatus("some-group");

    expect(data).not.toBeNull();
    expect(data!.unavailable).toBe(true);
  });

  it("rethrows a plain TypeError from the monitors query instead of degrading", async () => {
    vi.mocked(getStatusPageConfig).mockResolvedValue(resolvedConfig());
    dbMock.select.mockReturnValue(selectChain(new TypeError("Cannot read properties of undefined")));

    await expect(getPublicStatus()).rejects.toThrow(TypeError);
  });

  it("returns empty overallState with zero monitors and zero reports", async () => {
    vi.mocked(getStatusPageConfig).mockResolvedValue(resolvedConfig());
    dbMock.select.mockReturnValue(selectChain([])); // no monitors
    vi.mocked(getPublicReports).mockResolvedValue({ ongoing: [], upcoming: [], windowEnded: [], resolved: [] });

    const data = await getPublicStatus();
    expect(data!.overallState).toBe("empty");
  });

  it("folds an ongoing report's tier into overallState even with zero enabled monitors (finding: deriveOverallState short-circuited to \"empty\" before ever looking at ongoingReports)", async () => {
    vi.mocked(getStatusPageConfig).mockResolvedValue(resolvedConfig());
    dbMock.select.mockReturnValue(selectChain([])); // no monitors
    vi.mocked(getPublicReports).mockResolvedValue({
      ongoing: [{
        id: "report-1",
        type: "incident",
        title: "Manually authored outage",
        startsAt: "2026-07-18T10:00:00.000Z",
        endsAt: null,
        publishedAt: "2026-07-18T10:00:00.000Z",
        resolvedAt: null,
        originIncidentId: null,
        currentStatus: "investigating",
        phase: "ongoing",
        latestUpdate: null,
        affected: [{ monitorId: "gone", monitorName: "Archived monitor", groupName: null, impact: "degraded" }],
      }],
      upcoming: [],
      windowEnded: [],
      resolved: [],
    });

    const data = await getPublicStatus();
    expect(data!.overallState).toBe("degraded");
    expect(data!.reports.ongoing).toHaveLength(1);
  });

  it("returns null (existing 404 behavior) for a genuinely unknown group when the database is reachable", async () => {
    vi.mocked(getStatusPageConfig).mockResolvedValue(resolvedConfig());
    dbMock.select.mockReturnValue(selectChain([]));

    const data = await getPublicStatus("unknown-group");
    expect(data).toBeNull();
  });

  it("renders (does not 404) a group whose monitors are all archived but that still has a published report snapshotting the group name (finding: the group filter returned null before the report lookup)", async () => {
    vi.mocked(getStatusPageConfig).mockResolvedValue(resolvedConfig());
    // The monitors query only returns enabled, unarchived rows, so an
    // all-archived group is indistinguishable from an unknown one here.
    dbMock.select.mockReturnValue(selectChain([]));
    vi.mocked(getPublicReports).mockResolvedValue({
      ongoing: [{
        id: "report-1",
        type: "incident",
        title: "Core outage",
        startsAt: "2026-07-18T10:00:00.000Z",
        endsAt: null,
        publishedAt: "2026-07-18T10:00:00.000Z",
        resolvedAt: null,
        originIncidentId: null,
        currentStatus: "investigating",
        phase: "ongoing",
        latestUpdate: null,
        // The affected row is a snapshot of a monitor that has since been
        // archived. Only its snapshotted group name (slug "core") ties the
        // report to the /status/core URL.
        affected: [{ monitorId: "archived-1", monitorName: "Archived API", groupName: "Core", impact: "down" }],
      }],
      upcoming: [],
      windowEnded: [],
      resolved: [],
    });

    const data = await getPublicStatus("core");

    expect(data).not.toBeNull();
    expect(data!.groups).toEqual([]);
    expect(data!.reports.ongoing).toHaveLength(1);
    expect(data!.reports.ongoing[0]!.id).toBe("report-1");
    expect(data!.overallState).toBe("outage");
    // With zero visible monitors the scoping can only come from the slug:
    // getPublicReports resolves it back to the snapshotted group names, so
    // the fetch is still group-scoped and the row caps cannot starve it.
    expect(getPublicReports).toHaveBeenCalledWith(undefined, { monitorIds: [], groupSlug: "core" });
  });

  it("renders an archived-only group whose sole resolved report is older than 10 unrelated resolved reports (finding: with zero visible monitors the fetch ran unscoped, so the global resolved cap dropped the report before the slug filter and the page 404'd)", async () => {
    vi.mocked(getStatusPageConfig).mockResolvedValue(resolvedConfig());
    dbMock.select.mockReturnValue(selectChain([])); // all Core monitors archived
    function resolvedEntry(id: string, groupName: string) {
      return {
        id,
        type: "incident" as const,
        title: `${groupName} outage`,
        startsAt: "2026-07-18T10:00:00.000Z",
        endsAt: null,
        publishedAt: "2026-07-18T10:00:00.000Z",
        resolvedAt: "2026-07-18T11:00:00.000Z",
        originIncidentId: null,
        currentStatus: "resolved" as const,
        phase: "resolved" as const,
        latestUpdate: null,
        affected: [{ monitorId: `${id}-mon`, monitorName: `${groupName} API`, groupName, impact: "down" as const }],
      };
    }
    // The service applies its resolved cap AFTER scoping, so an unscoped
    // call surfaces only the 10 fresher unrelated reports while a scoped
    // call surfaces the group's own older report. Under the old code the
    // archived-only page called unscoped, saw zero matching rows after the
    // slug filter, and returned null.
    vi.mocked(getPublicReports).mockImplementation(async (_deps, filter) => ({
      ongoing: [],
      upcoming: [],
      windowEnded: [],
      resolved: filter?.groupSlug === "core"
        ? [resolvedEntry("report-core", "Core")]
        : Array.from({ length: 10 }, (_, index) => resolvedEntry(`report-other-${index}`, "Elsewhere")),
    }));

    const data = await getPublicStatus("core");

    expect(getPublicReports).toHaveBeenCalledWith(undefined, { monitorIds: [], groupSlug: "core" });
    expect(data).not.toBeNull();
    expect(data!.reports.resolved.map((report) => report.id)).toEqual(["report-core"]);
  });

  it("shows a report whose snapshotted group name differs from the live one only in accents/case (same slug) on the group page (finding: the SQL prefilter compared raw strings, excluding a 'Café' snapshot from /status/cafe once the group was respelled 'Cafe')", async () => {
    vi.mocked(getStatusPageConfig).mockResolvedValue(resolvedConfig());
    const monitorRow = { id: "mon-live", name: "Espresso API", groupName: "Cafe", state: "UP" };
    dbMock.select
      .mockReturnValueOnce(selectChain([monitorRow])) // monitors
      .mockReturnValueOnce(selectChain([])) // rollups
      .mockReturnValueOnce(selectChain([])) // current incidents
      .mockReturnValueOnce(selectChain([])); // recent incidents
    vi.mocked(getPublicReports).mockResolvedValue({
      ongoing: [{
        id: "report-cafe",
        type: "incident",
        title: "Legacy cafe outage",
        startsAt: "2026-07-18T10:00:00.000Z",
        endsAt: null,
        publishedAt: "2026-07-18T10:00:00.000Z",
        resolvedAt: null,
        originIncidentId: null,
        currentStatus: "investigating",
        phase: "ongoing",
        latestUpdate: null,
        // Archived monitor snapshotted under the accented spelling. Both
        // "Café" and the live "Cafe" slug to "cafe".
        affected: [{ monitorId: "mon-archived", monitorName: "Latte API", groupName: "Café", impact: "down" }],
      }],
      upcoming: [],
      windowEnded: [],
      resolved: [],
    });

    const data = await getPublicStatus("cafe");

    // The fetch passes the slug down, so the SQL prefilter can resolve it to
    // every snapshotted spelling instead of comparing live names raw.
    expect(getPublicReports).toHaveBeenCalledWith(undefined, { monitorIds: ["mon-live"], groupSlug: "cafe" });
    expect(data).not.toBeNull();
    expect(data!.reports.ongoing.map((report) => report.id)).toEqual(["report-cafe"]);
  });

  it("still returns null for an unknown group even when other groups have published reports", async () => {
    vi.mocked(getStatusPageConfig).mockResolvedValue(resolvedConfig());
    dbMock.select.mockReturnValue(selectChain([]));
    vi.mocked(getPublicReports).mockResolvedValue({
      ongoing: [],
      upcoming: [],
      windowEnded: [],
      resolved: [{
        id: "report-2",
        type: "incident",
        title: "Elsewhere outage",
        startsAt: "2026-07-18T10:00:00.000Z",
        endsAt: null,
        publishedAt: "2026-07-18T10:00:00.000Z",
        resolvedAt: "2026-07-18T11:00:00.000Z",
        originIncidentId: null,
        currentStatus: "resolved",
        phase: "resolved",
        latestUpdate: null,
        affected: [{ monitorId: "archived-2", monitorName: "Other API", groupName: "Elsewhere", impact: "down" }],
      }],
    });

    const data = await getPublicStatus("core");
    expect(data).toBeNull();
  });

  it("scopes getPublicReports to the group's monitor ids and slug on a group page, and leaves the root page unfiltered", async () => {
    vi.mocked(getStatusPageConfig).mockResolvedValue(resolvedConfig());
    const monitorRow = { id: "mon-1", name: "API", groupName: "Core", state: "UP" };
    dbMock.select
      .mockReturnValueOnce(selectChain([monitorRow])) // monitors
      .mockReturnValueOnce(selectChain([])) // rollups
      .mockReturnValueOnce(selectChain([])) // current incidents
      .mockReturnValueOnce(selectChain([])); // recent incidents

    await getPublicStatus("core");
    expect(getPublicReports).toHaveBeenCalledWith(undefined, { monitorIds: ["mon-1"], groupSlug: "core" });

    vi.mocked(getPublicReports).mockClear();
    dbMock.select.mockReturnValue(selectChain([]));
    await getPublicStatus();
    expect(getPublicReports).toHaveBeenCalledWith(undefined, undefined);
  });

  it("overfetches recent resolved incidents so minIncidentSeconds and promoted-fold filtering can't empty otherwise-visible history (finding: LIMIT 10 applied before either filter)", async () => {
    vi.mocked(getStatusPageConfig).mockResolvedValue({
      ...resolvedConfig(),
      data: { ...resolvedConfig().data, minIncidentSeconds: 600 },
    });
    const monitorRow = { id: "mon-1", name: "API", groupName: "Core", state: "UP" };

    // 15 resolved incidents, newest first (as the query's ORDER BY returns
    // them): the first 6 are short-duration (filtered by minIncidentSeconds),
    // one further down (index 7) is promoted (folded into its status report
    // and excluded), the rest are long-duration and unpromoted. Under the old
    // "LIMIT 10 before filtering" bug, only indices 0-9 would ever be fetched,
    // filtering those down to just 4 survivors instead of the 8 that
    // should be visible once the full overfetch is filtered correctly.
    const base = new Date("2026-07-18T12:00:00.000Z").getTime();
    const recentRows = Array.from({ length: 15 }, (_, index) => {
      const resolvedAt = new Date(base - index * 3_600_000);
      const shortDuration = index < 6;
      const openedAt = new Date(resolvedAt.getTime() - (shortDuration ? 60_000 : 3_600_000));
      return { id: `inc-${index}`, monitorName: "API", openedAt, resolvedAt };
    });
    const promotedIncidentId = "inc-7";

    const recentLimitSpy = vi.fn(() => Promise.resolve(recentRows));
    const recentChain = {
      from: () => recentChain,
      innerJoin: () => recentChain,
      where: () => recentChain,
      orderBy: () => recentChain,
      limit: recentLimitSpy,
    };
    dbMock.select
      .mockReturnValueOnce(selectChain([monitorRow])) // monitors
      .mockReturnValueOnce(selectChain([])) // rollups
      .mockReturnValueOnce(selectChain([])) // current (unresolved) incidents
      .mockReturnValueOnce(recentChain); // recent (resolved) incidents

    vi.mocked(getPublicReports).mockResolvedValue({
      ongoing: [],
      upcoming: [],
      windowEnded: [],
      resolved: [{
        id: "report-1",
        type: "incident",
        title: "API outage",
        startsAt: new Date(base).toISOString(),
        endsAt: null,
        publishedAt: new Date(base).toISOString(),
        resolvedAt: new Date(base).toISOString(),
        originIncidentId: promotedIncidentId,
        currentStatus: "resolved",
        phase: "resolved",
        latestUpdate: null,
        affected: [],
      }],
    });

    const data = await getPublicStatus();

    // The overfetch (60) is what makes the correct behavior possible.
    expect(recentLimitSpy).toHaveBeenCalledWith(60);
    // Surviving ids: the 6 short ones (0-5) are filtered by duration, inc-7
    // is filtered as promoted, leaving 6, 8, 9, 10, 11, 12, 13, 14 (8 rows),
    // well within the eventual 10-row display cap, but MORE than the old
    // buggy LIMIT-10-first code path could ever have surfaced.
    expect(data!.recentIncidents.map((incident) => incident.id)).toEqual([
      "inc-6", "inc-8", "inc-9", "inc-10", "inc-11", "inc-12", "inc-13", "inc-14",
    ]);
  });

  it("overfetches current (active) incidents so promoted-fold filtering can't drop otherwise-active incidents off the page (finding: LIMIT 100 applied before promoted exclusion)", async () => {
    vi.mocked(getStatusPageConfig).mockResolvedValue(resolvedConfig());
    const monitorRow = { id: "mon-1", name: "API", groupName: "Core", state: "DOWN" };

    // 110 simultaneously active (unresolved) incidents, newest first (as the
    // query's ORDER BY returns them): the newest 100 (inc-0..inc-99) are each
    // promoted into an ongoing published report. The oldest 10 (inc-100..
    // inc-109) are genuinely active and were never promoted. Under the old
    // "LIMIT 100 before promoted exclusion" bug, the query would fetch ONLY
    // inc-0..inc-99, exactly the promoted set, so excludePromotedIncidents
    // would remove all 100 fetched rows and currentIncidents would render
    // EMPTY, even though 10 genuinely active, unpromoted incidents exist.
    const base = new Date("2026-07-18T12:00:00.000Z").getTime();
    const currentRows = Array.from({ length: 110 }, (_, index) => ({
      id: `inc-${index}`,
      monitorName: "API",
      openedAt: new Date(base - index * 3_600_000),
      openingStatusCode: 503,
    }));

    const currentLimitSpy = vi.fn(() => Promise.resolve(currentRows));
    const currentChain = {
      from: () => currentChain,
      innerJoin: () => currentChain,
      where: () => currentChain,
      orderBy: () => currentChain,
      limit: currentLimitSpy,
    };
    dbMock.select
      .mockReturnValueOnce(selectChain([monitorRow])) // monitors
      .mockReturnValueOnce(selectChain([])) // rollups
      .mockReturnValueOnce(currentChain) // current (unresolved) incidents
      .mockReturnValueOnce(selectChain([])); // recent (resolved) incidents

    function promotedReportFor(incidentId: string) {
      return {
        id: `report-${incidentId}`,
        type: "incident" as const,
        title: "API outage",
        startsAt: new Date(base).toISOString(),
        endsAt: null,
        publishedAt: new Date(base).toISOString(),
        resolvedAt: null,
        originIncidentId: incidentId,
        currentStatus: "investigating" as const,
        phase: "ongoing" as const,
        latestUpdate: null,
        affected: [{ monitorId: "mon-1", monitorName: "API", groupName: "Core", impact: "down" as const }],
      };
    }
    vi.mocked(getPublicReports).mockResolvedValue({
      ongoing: Array.from({ length: 100 }, (_, index) => promotedReportFor(`inc-${index}`)),
      upcoming: [],
      windowEnded: [],
      resolved: [],
    });

    const data = await getPublicStatus();

    // The overfetch is what makes the correct behavior possible.
    expect(currentLimitSpy).toHaveBeenCalledWith(500);
    // The 100 newest (promoted) incidents fold into their ongoing reports.
    // The 10 oldest, unpromoted incidents still surface as currentIncidents,
    // none of them silently dropped by a query LIMIT sized too small to
    // survive exclusion.
    expect(data!.currentIncidents).toHaveLength(10);
    expect(data!.currentIncidents.map((incident) => incident.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `inc-${100 + index}`),
    );
  });

  it("excludes pre-activation buckets from public uptime and history so setup failures never read as downtime", async () => {
    vi.mocked(getStatusPageConfig).mockResolvedValue(resolvedConfig());
    const monitorRow = {
      id: "mon-1",
      name: "API",
      groupName: "Core",
      state: "UP",
      activatedAt: new Date("2026-07-10T00:00:00.000Z"),
    };
    // One daily bucket before activation carries setup failures, one after is
    // clean. Only the post-activation bucket may reach public uptime.
    const rollupRows = [
      { monitorId: "mon-1", bucketStart: new Date("2026-07-08T00:00:00.000Z"), expectedChecks: 10, completedChecks: 10, successfulChecks: 5, failedChecks: 5, unknownChecks: 0, downtimeSeconds: 600 },
      { monitorId: "mon-1", bucketStart: new Date("2026-07-12T00:00:00.000Z"), expectedChecks: 10, completedChecks: 10, successfulChecks: 10, failedChecks: 0, unknownChecks: 0, downtimeSeconds: 0 },
    ];
    dbMock.select
      .mockReturnValueOnce(selectChain([monitorRow])) // monitors
      .mockReturnValueOnce(selectChain(rollupRows)) // rollups
      .mockReturnValueOnce(selectChain([])) // current incidents
      .mockReturnValueOnce(selectChain([])); // recent incidents

    const data = await getPublicStatus();
    const monitor = data!.groups[0]!.monitors[0]!;
    // Unfiltered the mix would be 15/20 = 75%. Activation filtering keeps only
    // the clean post-activation bucket, so public uptime is a full 100% and no
    // pre-activation failure renders as a down history bucket.
    expect(monitor.uptime).toBe(100);
    expect(monitor.timeline.every((bucket) => bucket.state !== "down")).toBe(true);
  });

  it("reads a never-activated monitor as no data, never down, even with recorded failures", async () => {
    vi.mocked(getStatusPageConfig).mockResolvedValue(resolvedConfig());
    const monitorRow = { id: "mon-1", name: "API", groupName: "Core", state: "PENDING", activatedAt: null };
    const rollupRows = [
      { monitorId: "mon-1", bucketStart: new Date("2026-07-12T00:00:00.000Z"), expectedChecks: 10, completedChecks: 10, successfulChecks: 0, failedChecks: 10, unknownChecks: 0, downtimeSeconds: 600 },
    ];
    dbMock.select
      .mockReturnValueOnce(selectChain([monitorRow])) // monitors
      .mockReturnValueOnce(selectChain(rollupRows)) // rollups
      .mockReturnValueOnce(selectChain([])) // current incidents
      .mockReturnValueOnce(selectChain([])); // recent incidents

    const data = await getPublicStatus();
    const monitor = data!.groups[0]!.monitors[0]!;
    expect(monitor.uptime).toBeNull();
    expect(monitor.timeline.every((bucket) => bucket.state !== "down")).toBe(true);
  });
});

describe("getPublicReportDetail", () => {
  it("returns the distinct \"unavailable\" sentinel (not null) on an ECONNREFUSED-shaped error", async () => {
    vi.mocked(getStatusReport).mockRejectedValue(connectionError("ECONNREFUSED"));
    await expect(getPublicReportDetail("report-1")).resolves.toBe("unavailable");
  });

  it("still returns null (404) for an unknown report id", async () => {
    vi.mocked(getStatusReport).mockRejectedValue(new StatusReportError("REPORT_NOT_FOUND", "not found"));
    await expect(getPublicReportDetail("report-1")).resolves.toBeNull();
  });

  it("rethrows a plain app error", async () => {
    vi.mocked(getStatusReport).mockRejectedValue(new TypeError("boom"));
    await expect(getPublicReportDetail("report-1")).rejects.toThrow(TypeError);
  });
});

describe("groupByMonitorId", () => {
  it("groups rows by monitor id in one pass, preserving each monitor's relative order", () => {
    const rows = [
      { monitorId: "a", bucketStart: "2026-07-01" },
      { monitorId: "b", bucketStart: "2026-07-01" },
      { monitorId: "a", bucketStart: "2026-07-02" },
      { monitorId: "a", bucketStart: "2026-07-03" },
      { monitorId: "b", bucketStart: "2026-07-02" },
    ];

    const grouped = groupByMonitorId(rows);

    expect(grouped.get("a")).toEqual([
      { monitorId: "a", bucketStart: "2026-07-01" },
      { monitorId: "a", bucketStart: "2026-07-02" },
      { monitorId: "a", bucketStart: "2026-07-03" },
    ]);
    expect(grouped.get("b")).toEqual([
      { monitorId: "b", bucketStart: "2026-07-01" },
      { monitorId: "b", bucketStart: "2026-07-02" },
    ]);
  });

  it("produces the same per-monitor subset as a naive filter would", () => {
    const rows = [
      { monitorId: "a", value: 1 },
      { monitorId: "c", value: 2 },
      { monitorId: "b", value: 3 },
      { monitorId: "a", value: 4 },
      { monitorId: "c", value: 5 },
    ];

    const grouped = groupByMonitorId(rows);

    for (const id of ["a", "b", "c"]) {
      expect(grouped.get(id) ?? []).toEqual(rows.filter((row) => row.monitorId === id));
    }
  });

  it("returns no entry for a monitor with zero matching rows", () => {
    const grouped = groupByMonitorId([{ monitorId: "a", value: 1 }]);

    expect(grouped.get("missing")).toBeUndefined();
    expect(grouped.get("missing") ?? []).toEqual([]);
  });

  it("returns an empty map for an empty input", () => {
    expect(groupByMonitorId([]).size).toBe(0);
  });
});
