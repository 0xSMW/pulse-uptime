import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: { unsafe: vi.fn() },
}));
vi.mock("@/lib/db/client", () => ({ sql: sqlMock }));

import {
  fetchRawAvailabilityBuckets,
  fetchRawAvailabilityBucketsForMonitor,
  mapRawAvailabilityRow,
  RAW_AVAILABILITY_BUCKETS_SQL,
} from "./raw-availability";
import { blendRawAvailability, buildRollupTimeline, summarizeRollupCoverage } from "./timeline";

describe("mapRawAvailabilityRow", () => {
  it("maps bit-derived counts and zeros downtime on the raw side", () => {
    expect(mapRawAvailabilityRow({
      monitor_id: "mon-a",
      bucket_start: "2026-07-20T00:00:00.000Z",
      expected_checks: "15",
      completed_checks: "1",
      successful_checks: "1",
      failed_checks: "0",
      unknown_checks: "14",
    })).toEqual({
      monitorId: "mon-a",
      bucketStart: new Date("2026-07-20T00:00:00.000Z"),
      expectedChecks: 15,
      completedChecks: 1,
      successfulChecks: 1,
      failedChecks: 0,
      unknownChecks: 14,
      downtimeSeconds: 0,
    });
  });
});

describe("RAW_AVAILABILITY_BUCKETS_SQL shape", () => {
  it("ranges check_batches before unnest and filters by monitor ids", () => {
    const sql = RAW_AVAILABILITY_BUCKETS_SQL;
    const rangedIndex = sql.indexOf("from check_batches");
    const unnestIndex = sql.indexOf("unnest(ranged.monitor_ids)");
    expect(rangedIndex).toBeGreaterThan(-1);
    expect(unnestIndex).toBeGreaterThan(rangedIndex);
    expect(sql).toContain("where scheduled_minute >= $1::timestamptz");
    expect(sql).toContain("and scheduled_minute < $2::timestamptz");
    expect(sql).toContain("ids.monitor_id = any($3::text[])");
    expect(sql).toContain("with ordinality");
    // Bit rules match compaction: expected, completed, failure.
    expect(sql).toContain("expected = 1 and slots.completed = 1 and slots.failed = 0");
    expect(sql).toContain("expected = 1 and slots.completed = 1 and slots.failed = 1");
    expect(sql).toContain("expected = 1 and slots.completed = 0");
  });
});

describe("fetchRawAvailabilityBuckets", () => {
  beforeEach(() => {
    sqlMock.unsafe.mockReset();
  });

  it("skips the database when no monitors are requested", async () => {
    expect(await fetchRawAvailabilityBuckets([], new Date("2026-07-20T00:00:00Z"), new Date("2026-07-20T01:00:00Z")))
      .toEqual([]);
    expect(sqlMock.unsafe).not.toHaveBeenCalled();
  });

  it("skips the database when the window is empty", async () => {
    const at = new Date("2026-07-20T00:00:00Z");
    expect(await fetchRawAvailabilityBuckets(["mon-a"], at, at)).toEqual([]);
    expect(sqlMock.unsafe).not.toHaveBeenCalled();
  });

  it("maps rows from the shared batch query", async () => {
    sqlMock.unsafe.mockResolvedValueOnce([{
      monitor_id: "mon-a",
      bucket_start: new Date("2026-07-20T00:00:00Z"),
      expected_checks: 15,
      completed_checks: 1,
      successful_checks: 1,
      failed_checks: 0,
      unknown_checks: 14,
    }]);

    const start = new Date("2026-07-20T00:00:00Z");
    const end = new Date("2026-07-20T00:15:00Z");
    const rows = await fetchRawAvailabilityBuckets(["mon-a"], start, end);

    expect(sqlMock.unsafe).toHaveBeenCalledWith(
      RAW_AVAILABILITY_BUCKETS_SQL,
      [start.toISOString(), end.toISOString(), ["mon-a"]],
    );
    expect(rows).toEqual([{
      monitorId: "mon-a",
      bucketStart: new Date("2026-07-20T00:00:00Z"),
      expectedChecks: 15,
      completedChecks: 1,
      successfulChecks: 1,
      failedChecks: 0,
      unknownChecks: 14,
      downtimeSeconds: 0,
    }]);
  });

  it("degrades to an empty list when the query fails", async () => {
    sqlMock.unsafe.mockRejectedValueOnce(new Error("decode failed"));
    expect(await fetchRawAvailabilityBuckets(
      ["mon-a"],
      new Date("2026-07-20T00:00:00Z"),
      new Date("2026-07-20T01:00:00Z"),
    )).toEqual([]);
  });

  it("strips monitorId for the single-monitor helper", async () => {
    sqlMock.unsafe.mockResolvedValueOnce([{
      monitor_id: "mon-a",
      bucket_start: new Date("2026-07-20T00:00:00Z"),
      expected_checks: 2,
      completed_checks: 2,
      successful_checks: 2,
      failed_checks: 0,
      unknown_checks: 0,
    }]);

    const rows = await fetchRawAvailabilityBucketsForMonitor(
      "mon-a",
      new Date("2026-07-20T00:00:00Z"),
      new Date("2026-07-20T00:15:00Z"),
    );
    expect(rows).toEqual([{
      bucketStart: new Date("2026-07-20T00:00:00Z"),
      expectedChecks: 2,
      completedChecks: 2,
      successfulChecks: 2,
      failedChecks: 0,
      unknownChecks: 0,
      downtimeSeconds: 0,
    }]);
  });
});

describe("scheduler-derived raw availability acceptance", () => {
  const bucketAt = (
    iso: string,
    expected: number,
    completed: number,
    successful: number,
    failed = 0,
  ) => ({
    bucketStart: new Date(iso),
    expectedChecks: expected,
    completedChecks: completed,
    successfulChecks: successful,
    failedChecks: failed,
    unknownChecks: expected - completed,
    downtimeSeconds: 0,
  });

  it("15 expected, 1 successful completion is incomplete coverage, not fully up", () => {
    const raw = [bucketAt("2026-07-20T00:00:00Z", 15, 1, 1)];
    expect(raw[0]).toMatchObject({
      expectedChecks: 15,
      completedChecks: 1,
      successfulChecks: 1,
      unknownChecks: 14,
    });

    const summary = summarizeRollupCoverage(raw);
    // Headline uptime uses successful/completed; unknown is coverage only.
    expect(summary.uptime).toBe(100);
    expect(summary.coverage).toBeCloseTo(1 / 15);

    const timeline = buildRollupTimeline(
      blendRawAvailability([], raw),
      1,
      15 * 60 * 1_000,
      new Date("2026-07-20T00:15:00Z"),
    );
    expect(timeline[0]).toMatchObject({
      state: "verifying",
      checks: 15,
      failures: 0,
    });
  });

  it("fully completed successful bucket is full coverage and up", () => {
    const raw = [bucketAt("2026-07-20T00:00:00Z", 15, 15, 15)];
    expect(summarizeRollupCoverage(raw)).toEqual({ uptime: 100, coverage: 1 });
    const timeline = buildRollupTimeline(
      blendRawAvailability([], raw),
      1,
      15 * 60 * 1_000,
      new Date("2026-07-20T00:15:00Z"),
    );
    expect(timeline[0]).toMatchObject({ state: "up", checks: 15, failures: 0 });
  });

  it("expected with zero completions has no observed availability and zero coverage", () => {
    const raw = [bucketAt("2026-07-20T00:00:00Z", 15, 0, 0)];
    expect(summarizeRollupCoverage(raw)).toEqual({ uptime: null, coverage: 0 });
    const timeline = buildRollupTimeline(
      blendRawAvailability([], raw),
      1,
      15 * 60 * 1_000,
      new Date("2026-07-20T00:15:00Z"),
    );
    expect(timeline[0]).toMatchObject({ state: "no-data", checks: 15, failures: 0 });
  });

  it("does not treat unknown slots as failures in the uptime ratio", () => {
    // 10 expected, 4 completed of which 3 succeed and 1 fails, 6 unknown.
    const raw = [bucketAt("2026-07-20T00:00:00Z", 10, 4, 3, 1)];
    const summary = summarizeRollupCoverage(raw);
    expect(summary.uptime).toBe(75);
    expect(summary.coverage).toBe(0.4);
    expect(raw[0]!.unknownChecks).toBe(6);
  });
});
