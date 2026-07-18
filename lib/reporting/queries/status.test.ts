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
