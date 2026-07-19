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
  return { data: { ...document, updatedAt: null }, etag: '"0"' };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.select.mockReset();
  // Default: no rows anywhere, no reports — success path, empty status.
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

  it("returns null (existing 404 behavior) for a genuinely unknown group when the database is reachable", async () => {
    vi.mocked(getStatusPageConfig).mockResolvedValue(resolvedConfig());
    dbMock.select.mockReturnValue(selectChain([]));

    const data = await getPublicStatus("unknown-group");
    expect(data).toBeNull();
  });

  it("scopes getPublicReports to the group's monitors/group names on a group page, and leaves the root page unfiltered", async () => {
    vi.mocked(getStatusPageConfig).mockResolvedValue(resolvedConfig());
    const monitorRow = { id: "mon-1", name: "API", groupName: "Core", state: "UP" };
    dbMock.select
      .mockReturnValueOnce(selectChain([monitorRow])) // monitors
      .mockReturnValueOnce(selectChain([])) // rollups
      .mockReturnValueOnce(selectChain([])) // current incidents
      .mockReturnValueOnce(selectChain([])); // recent incidents

    await getPublicStatus("core");
    expect(getPublicReports).toHaveBeenCalledWith(undefined, { monitorIds: ["mon-1"], groupNames: ["Core"] });

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
    // "LIMIT 10 before filtering" bug, only indices 0-9 would ever be fetched
    // — filtering those down to just 4 survivors — instead of the 8 that
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
    // is filtered as promoted, leaving 6, 8, 9, 10, 11, 12, 13, 14 (8 rows) —
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
    // promoted into an ongoing published report; the oldest 10 (inc-100..
    // inc-109) are genuinely active and were never promoted. Under the old
    // "LIMIT 100 before promoted exclusion" bug, the query would fetch ONLY
    // inc-0..inc-99 — exactly the promoted set — so excludePromotedIncidents
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
    // The 100 newest (promoted) incidents fold into their ongoing reports;
    // the 10 oldest, unpromoted incidents still surface as currentIncidents
    // — none of them silently dropped by a query LIMIT sized too small to
    // survive exclusion.
    expect(data!.currentIncidents).toHaveLength(10);
    expect(data!.currentIncidents.map((incident) => incident.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `inc-${100 + index}`),
    );
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
