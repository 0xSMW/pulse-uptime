import { describe, expect, it } from "vitest";

import { summarizeCounts } from "./first-run";
import {
  buildFirstRun,
  buildLatestIncident,
  buildRecentChecks,
  buildRecentIncidents,
  observedWithRawTail,
  openingFailure,
  rawChecksSinceActivation,
  rollupVersionOf,
  secondsBetween,
  type LiveIncidentRow,
  type LiveRollupRow,
  type RawMinuteCheck,
} from "./live-summary";

const now = new Date("2026-07-19T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const DAY = 86_400_000;

function rollup(overrides: Partial<LiveRollupRow>): LiveRollupRow {
  return {
    bucketStart: ago(DAY),
    expectedChecks: 15,
    completedChecks: 15,
    failedChecks: 0,
    unknownChecks: 0,
    latencyCount: 15,
    latencySumMs: 1_500n,
    ...overrides,
  };
}

function incident(overrides: Partial<LiveIncidentRow>): LiveIncidentRow {
  return {
    id: "inc-1",
    openedAt: ago(2 * 3_600_000),
    resolvedAt: null,
    openingErrorCode: null,
    openingStatusCode: null,
    ...overrides,
  };
}

describe("openingFailure", () => {
  it("prefers the status code", () => {
    expect(openingFailure("ETIMEDOUT", 503)).toBe("HTTP 503");
  });

  it("falls back to the error code then a default", () => {
    expect(openingFailure("ETIMEDOUT", null)).toBe("ETIMEDOUT");
    expect(openingFailure(null, null)).toBe("Unknown failure");
  });
});

describe("secondsBetween", () => {
  it("floors to whole seconds and never goes negative", () => {
    expect(secondsBetween(ago(90_500), now)).toBe(90);
    expect(secondsBetween(now, ago(1_000))).toBe(0);
  });
});

describe("rollupVersionOf", () => {
  it("is null with no completed buckets", () => {
    expect(rollupVersionOf([])).toBeNull();
  });

  it("is the last bucket start, which advances with a new bucket", () => {
    const older = rollup({ bucketStart: ago(2 * DAY) });
    const newer = rollup({ bucketStart: ago(DAY) });
    expect(rollupVersionOf([older, newer])).toBe(newer.bucketStart.toISOString());
    const advanced = rollup({ bucketStart: ago(DAY - 900_000) });
    expect(rollupVersionOf([older, newer, advanced])).toBe(advanced.bucketStart.toISOString());
  });
});

describe("buildLatestIncident", () => {
  it("is null without incidents", () => {
    expect(buildLatestIncident([], now)).toBeNull();
  });

  it("marks an unresolved incident ongoing", () => {
    const result = buildLatestIncident([incident({ resolvedAt: null, openingStatusCode: 500 })], now);
    expect(result).toMatchObject({ state: "ONGOING", openingFailure: "HTTP 500", resolvedAt: null });
  });

  it("keeps a resolution inside the last day and drops an older one", () => {
    const recent = buildLatestIncident([incident({ resolvedAt: ago(3_600_000) })], now);
    expect(recent).toMatchObject({ state: "RESOLVED" });
    const stale = buildLatestIncident([incident({ resolvedAt: ago(2 * DAY) })], now);
    expect(stale).toBeNull();
  });
});

describe("buildRecentIncidents", () => {
  it("maps every row with a duration to now for unresolved ones", () => {
    const rows = [
      incident({ id: "a", openedAt: ago(3_600_000), resolvedAt: null }),
      incident({ id: "b", openedAt: ago(2 * DAY), resolvedAt: ago(2 * DAY - 600_000), openingStatusCode: 502 }),
    ];
    const mapped = buildRecentIncidents(rows, now);
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({ id: "a", durationSeconds: 3_600, openingFailure: "Unknown failure" });
    expect(mapped[1]).toMatchObject({ id: "b", durationSeconds: 600, openingFailure: "HTTP 502" });
  });
});

describe("buildRecentChecks", () => {
  it("takes the last twenty buckets newest first", () => {
    const rows = Array.from({ length: 25 }, (_, index) =>
      rollup({ bucketStart: ago((25 - index) * 900_000) }),
    );
    const checks = buildRecentChecks(rows);
    expect(checks).toHaveLength(20);
    expect(checks[0]!.checkedAt).toBe(rows.at(-1)!.bucketStart.toISOString());
  });

  it("labels coverage gaps, failures, and healthy rollups", () => {
    const unknown = buildRecentChecks([rollup({ completedChecks: 10, unknownChecks: 5 })])[0]!;
    expect(unknown).toMatchObject({ successful: false, resultLabel: "Unknown coverage" });
    const failed = buildRecentChecks([rollup({ failedChecks: 3, completedChecks: 15 })])[0]!;
    expect(failed).toMatchObject({ successful: false, resultLabel: "Failed checks" });
    const healthy = buildRecentChecks([rollup({})])[0]!;
    expect(healthy).toMatchObject({ successful: true, resultLabel: "Healthy rollup", latencyMs: 100 });
  });

  it("reports null latency when no samples were recorded", () => {
    expect(buildRecentChecks([rollup({ latencyCount: 0, latencySumMs: 0n })])[0]!.latencyMs).toBeNull();
  });
});

describe("rawChecksSinceActivation", () => {
  const check = (overrides: Partial<RawMinuteCheck>): RawMinuteCheck => ({
    checked_at: ago(DAY),
    completed: true,
    failed: false,
    latency_ms: 90,
    ...overrides,
  });
  const activatedAt = ago(6 * 3_600_000);

  it("drops a check before activation and keeps one at or after it", () => {
    const before = check({ checked_at: ago(12 * 3_600_000), failed: true });
    const atCutoff = check({ checked_at: activatedAt });
    const after = check({ checked_at: ago(3_600_000) });

    const kept = rawChecksSinceActivation([before, atCutoff, after], activatedAt);

    expect(kept).toEqual([atCutoff, after]);
  });

  it("returns an empty array for an unactivated monitor", () => {
    expect(rawChecksSinceActivation([check({})], null)).toEqual([]);
  });
});

describe("observedWithRawTail", () => {
  const completedRollup = (overrides: Partial<{
    bucketStart: Date;
    expectedChecks: number;
    completedChecks: number;
    successfulChecks: number;
    failedChecks: number;
  }>) => ({
    bucketStart: ago(30 * 60_000),
    expectedChecks: 15,
    completedChecks: 15,
    successfulChecks: 15,
    failedChecks: 0,
    ...overrides,
  });
  const rawCheck = (overrides: Partial<RawMinuteCheck>): RawMinuteCheck => ({
    checked_at: ago(60_000),
    completed: true,
    failed: false,
    latency_ms: 90,
    ...overrides,
  });

  it("counts raw successes immediately when no rollup has compacted yet", () => {
    const observed = observedWithRawTail([], [
      rawCheck({ checked_at: ago(3 * 60_000) }),
      rawCheck({ checked_at: ago(2 * 60_000) }),
      rawCheck({ checked_at: ago(60_000) }),
    ]);
    expect(observed).toMatchObject({ expected: 3, completed: 3, successful: 3, uptime: 100 });
    expect(observed.coverage).toBe(1);
  });

  it("adds only the tail after the newest completed bucket end, never double counting", () => {
    // Newest completed bucket starts 30m ago, so it ends 15m ago. A raw minute
    // inside that compacted bucket is dropped, the two after its end are folded.
    const rollups = [completedRollup({ bucketStart: ago(30 * 60_000) })];
    const observed = observedWithRawTail(rollups, [
      rawCheck({ checked_at: ago(20 * 60_000) }),
      rawCheck({ checked_at: ago(10 * 60_000) }),
      rawCheck({ checked_at: ago(5 * 60_000) }),
    ]);
    expect(observed).toMatchObject({ expected: 17, completed: 17, successful: 17 });
  });

  it("does not recount a minute once a rollup covers it", () => {
    // The same raw minute at 5m ago now falls inside a freshly compacted bucket
    // that starts 15m ago and ends now, so the tail is empty and the count holds.
    const rollups = [completedRollup({ bucketStart: ago(15 * 60_000), expectedChecks: 14, completedChecks: 14, successfulChecks: 14 })];
    const observed = observedWithRawTail(rollups, [rawCheck({ checked_at: ago(5 * 60_000) })]);
    expect(observed).toMatchObject({ expected: 14, completed: 14, successful: 14 });
  });

  it("keeps tail coverage honest for an unknown minute and never exceeds 100 uptime", () => {
    const observed = observedWithRawTail([], [
      rawCheck({ checked_at: ago(3 * 60_000) }),
      rawCheck({ checked_at: ago(2 * 60_000), completed: false }),
      rawCheck({ checked_at: ago(60_000), completed: true, failed: true }),
    ]);
    expect(observed.expected).toBe(3);
    expect(observed.completed).toBe(2);
    expect(observed.successful).toBe(1);
    expect(observed.failed).toBe(1);
    expect(observed.uptime).toBe(50);
    expect(observed.coverage).toBeCloseTo(2 / 3);
  });
});

describe("buildFirstRun", () => {
  const identity = {
    activatedAt: null as Date | null,
    consecutiveFailures: 0 as number | null,
    lastErrorCode: null as string | null,
    lastStatusCode: null as number | null,
    lastCheckedAt: null as Date | null,
  };

  it("is setup with a surfaced last failure before activation", () => {
    const observed = summarizeCounts([]);
    const result = buildFirstRun(
      { ...identity, consecutiveFailures: 2, lastStatusCode: 500, lastCheckedAt: ago(60_000) },
      observed,
      now,
    );
    expect(result).toMatchObject({ phase: "setup", setupError: "HTTP 500", activatedAt: null });
    expect(result.lastCheckedAt).toBe(ago(60_000).toISOString());
  });

  it("has no setup error once activated and carries observed counts", () => {
    const observed = summarizeCounts([
      { expectedChecks: 20, completedChecks: 18, successfulChecks: 18, failedChecks: 0 },
    ]);
    const result = buildFirstRun({ ...identity, activatedAt: ago(6 * 3_600_000) }, observed, now);
    expect(result).toMatchObject({ phase: "collecting", setupError: null });
    expect(result.observed).toEqual({ uptime: 100, completed: 18, expected: 20 });
    expect(result.observedSeconds).toBe(6 * 3_600);
  });
});
