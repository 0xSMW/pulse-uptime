import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { dbMock, sqlMock } = vi.hoisted(() => ({
  dbMock: { select: vi.fn() },
  sqlMock: { unsafe: vi.fn() },
}));
vi.mock("@/lib/db/client", () => ({ db: dbMock, sql: sqlMock }));

import { getMonitorDetail, getMonitorLive, selectRecentRollupWindow } from "./monitors";

// A chainable stand-in for a drizzle select. Every builder method returns the
// node, and the node itself is a thenable, so awaiting at any terminal (limit,
// orderBy, or the raw chain) resolves to the queued rows.
function selectChain(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  const node = {
    from: () => node,
    leftJoin: () => node,
    innerJoin: () => node,
    where: () => node,
    orderBy: () => node,
    limit: () => node,
    then: (res: (value: unknown[]) => unknown, rej?: (reason: unknown) => unknown) => promise.then(res, rej),
    catch: (rej: (reason: unknown) => unknown) => promise.catch(rej),
    finally: (fn: () => void) => promise.finally(fn),
  };
  return node;
}

const NOW = new Date("2026-07-19T12:07:00.000Z");
// end15m floors to 2026-07-19T12:00Z, so the 24h window is [07-18T12:00, 07-19T12:00).
const ACTIVATED_AT = new Date("2026-07-19T06:00:00.000Z");
const PRE_BUCKET = new Date("2026-07-19T00:00:00.000Z"); // before activation, inside 24h
const POST_BUCKET = new Date("2026-07-19T08:00:00.000Z"); // after activation

const LOW_HISTOGRAM = [10, 0, 0, 0, 0, 0, 0, 0]; // p95 lands in the <=100ms bucket
const HIGH_HISTOGRAM = [0, 0, 0, 0, 0, 0, 10, 0]; // p95 lands in the <=10000ms bucket

function rollup(overrides: Record<string, unknown>) {
  return {
    bucketStart: POST_BUCKET,
    expectedChecks: 10,
    completedChecks: 10,
    successfulChecks: 10,
    failedChecks: 0,
    unknownChecks: 0,
    downtimeSeconds: 0,
    latencyCount: 10,
    latencySumMs: 900,
    latencyMaxMs: 90,
    latencyHistogram: LOW_HISTOGRAM,
    ...overrides,
  };
}

function identity(overrides: Record<string, unknown>) {
  return {
    id: "site-home",
    name: "Home",
    url: "https://example.test",
    group: null,
    enabled: true,
    state: "UP",
    latestLatencyMs: 90,
    activatedAt: ACTIVATED_AT,
    lastCheckedAt: NOW,
    lastErrorCode: null,
    lastStatusCode: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

// A pre-activation bucket that is slow and failing, and a post-activation
// bucket that is fast and healthy. The activation gate must drop the first.
const PRE_ACTIVATION_ROLLUP = rollup({
  bucketStart: PRE_BUCKET,
  latencyHistogram: HIGH_HISTOGRAM,
  latencyMaxMs: 9_000,
  latencySumMs: 90_000,
  failedChecks: 10,
  successfulChecks: 0,
});
const POST_ACTIVATION_ROLLUP = rollup({ bucketStart: POST_BUCKET });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dbMock.select.mockReset();
  sqlMock.unsafe.mockReset();
  sqlMock.unsafe.mockResolvedValue([]); // no raw minute rows, fall back to rollups
});

describe("getMonitorLive p95 and incidents", () => {
  it("computes p95 from activation-filtered rollups, excluding a slow setup bucket", async () => {
    dbMock.select
      .mockReturnValueOnce(selectChain([identity({})])) // getMonitorIdentity
      .mockReturnValueOnce(selectChain([PRE_ACTIVATION_ROLLUP, POST_ACTIVATION_ROLLUP])) // rollups 15m
      .mockReturnValueOnce(selectChain([])); // incidents

    const live = await getMonitorLive("site-home");

    // Post-activation bucket alone lands in the <=100ms histogram bucket. The
    // slow pre-activation bucket would have pulled this to 10000ms unfiltered.
    expect(live!.p95LatencyMs).toBe(100);
  });

  it("surfaces no incidents and issues no incident query when the monitor never activated", async () => {
    dbMock.select
      .mockReturnValueOnce(selectChain([identity({ activatedAt: null, state: "PENDING" })])) // identity
      .mockReturnValueOnce(selectChain([])); // rollups 15m

    const live = await getMonitorLive("site-home");

    expect(live!.latestIncident).toBeNull();
    expect(live!.recentIncidents).toEqual([]);
    // Only identity and rollups were queried, never the incidents table.
    expect(dbMock.select).toHaveBeenCalledTimes(2);
  });

  it("keeps a genuine ongoing incident that opened at or after activation", async () => {
    const ongoing = {
      id: "inc-1",
      openedAt: new Date("2026-07-19T09:00:00.000Z"),
      resolvedAt: null,
      openingErrorCode: "ETIMEDOUT",
      openingStatusCode: null,
    };
    dbMock.select
      .mockReturnValueOnce(selectChain([identity({ state: "DOWN" })])) // identity
      .mockReturnValueOnce(selectChain([POST_ACTIVATION_ROLLUP])) // rollups 15m
      .mockReturnValueOnce(selectChain([ongoing])); // incidents

    const live = await getMonitorLive("site-home");

    expect(live!.latestIncident).not.toBeNull();
    expect(live!.latestIncident!.state).toBe("ONGOING");
    expect(live!.recentIncidents).toHaveLength(1);
  });
});

describe("getMonitorDetail latency and response chart", () => {
  it("filters p95 and the response chart to activation, dropping the setup bucket", async () => {
    dbMock.select
      .mockReturnValueOnce(selectChain([identity({})])) // identity
      .mockReturnValueOnce(selectChain([PRE_ACTIVATION_ROLLUP, POST_ACTIVATION_ROLLUP])) // rollups 15m
      .mockReturnValueOnce(selectChain([])) // rollups hour
      .mockReturnValueOnce(selectChain([])) // rollups day
      .mockReturnValueOnce(selectChain([])) // incidents
      .mockReturnValueOnce(selectChain([])); // accepted config

    const detail = await getMonitorDetail("site-home");

    expect(detail!.p95LatencyMs).toBe(100);
    // The response chart keeps only the post-activation point.
    expect(detail!.responseTime.h24).toHaveLength(1);
    expect(detail!.responseTime.h24[0]!.timestamp).toBe(POST_BUCKET.toISOString());
  });

  it("issues no incident query when the monitor never activated", async () => {
    dbMock.select
      .mockReturnValueOnce(selectChain([identity({ activatedAt: null, state: "PENDING" })])) // identity
      .mockReturnValueOnce(selectChain([])) // rollups 15m
      .mockReturnValueOnce(selectChain([])) // rollups hour
      .mockReturnValueOnce(selectChain([])) // rollups day
      .mockReturnValueOnce(selectChain([])); // accepted config (no incidents select)

    const detail = await getMonitorDetail("site-home");

    expect(detail!.latestIncident).toBeNull();
    expect(detail!.recentIncidents).toEqual([]);
    // identity + three rollup fetches + config, but never the incidents table.
    expect(dbMock.select).toHaveBeenCalledTimes(5);
  });
});

describe("selectRecentRollupWindow", () => {
  const rowAt = (iso: string) => ({ bucketStart: new Date(iso) });

  it("includes a row exactly at the cutoff and excludes one just before it", () => {
    const cutoff = new Date("2026-07-18T00:00:00Z").getTime();
    const end = new Date("2026-07-19T00:00:00Z").getTime();
    const rows = [
      rowAt("2026-07-17T23:59:59.999Z"),
      rowAt("2026-07-18T00:00:00.000Z"),
    ];

    const result = selectRecentRollupWindow(rows, cutoff, end);

    expect(result).toEqual([rowAt("2026-07-18T00:00:00.000Z")]);
  });

  it("excludes a row exactly at the end and includes one just before it", () => {
    const cutoff = new Date("2026-07-18T00:00:00Z").getTime();
    const end = new Date("2026-07-19T00:00:00Z").getTime();
    const rows = [
      rowAt("2026-07-18T23:59:59.999Z"),
      rowAt("2026-07-19T00:00:00.000Z"),
    ];

    const result = selectRecentRollupWindow(rows, cutoff, end);

    expect(result).toEqual([rowAt("2026-07-18T23:59:59.999Z")]);
  });

  it("preserves ascending order from the superset without resorting", () => {
    const cutoff = new Date("2026-07-11T00:00:00Z").getTime();
    const end = new Date("2026-07-18T00:00:00Z").getTime();
    const rows = [
      rowAt("2026-07-10T00:00:00Z"),
      rowAt("2026-07-12T00:00:00Z"),
      rowAt("2026-07-14T00:00:00Z"),
      rowAt("2026-07-16T00:00:00Z"),
    ];

    const result = selectRecentRollupWindow(rows, cutoff, end);

    expect(result.map((row) => row.bucketStart.toISOString())).toEqual([
      "2026-07-12T00:00:00.000Z",
      "2026-07-14T00:00:00.000Z",
      "2026-07-16T00:00:00.000Z",
    ]);
  });

  it("returns an empty array when nothing falls in the window", () => {
    const cutoff = new Date("2026-07-18T00:00:00Z").getTime();
    const end = new Date("2026-07-19T00:00:00Z").getTime();

    expect(selectRecentRollupWindow([rowAt("2026-07-10T00:00:00Z")], cutoff, end)).toEqual([]);
  });
});
