import { describe, expect, it } from "vitest";

import {
  CONSECUTIVE_FAILURE_THRESHOLD,
  countLeadingFailures,
  evaluateLoopHealth,
  isLoopStale,
  type CronRunStatus,
} from "./loop-health";

const now = new Date("2026-07-20T00:10:00.000Z");
const minutesAgo = (value: number) => new Date(now.getTime() - value * 60_000);

describe("countLeadingFailures", () => {
  it("counts an unbroken run of failures from the newest run", () => {
    expect(countLeadingFailures(["failed", "failed", "failed"])).toBe(3);
  });

  it("stops at the first non-failed run", () => {
    expect(countLeadingFailures(["failed", "completed", "failed"])).toBe(1);
  });

  it("returns zero when the newest run completed", () => {
    expect(countLeadingFailures(["completed", "failed", "failed"])).toBe(0);
  });

  it("returns zero for no runs", () => {
    expect(countLeadingFailures([])).toBe(0);
  });
});

describe("isLoopStale", () => {
  it("treats a never-completed loop as stale", () => {
    expect(isLoopStale(null, now, 5 * 60_000)).toBe(true);
  });

  it("is stale past the window and fresh within it", () => {
    expect(isLoopStale(minutesAgo(6), now, 5 * 60_000)).toBe(true);
    expect(isLoopStale(minutesAgo(2), now, 5 * 60_000)).toBe(false);
  });
});

describe("evaluateLoopHealth", () => {
  const failing: CronRunStatus[] = Array.from({ length: CONSECUTIVE_FAILURE_THRESHOLD }, () => "failed");

  it("reports staleness first even when runs are also failing", () => {
    const result = evaluateLoopHealth({ lastCompletedAt: minutesAgo(30), recentStatuses: failing, now });
    expect(result).toMatchObject({ unhealthy: true, reason: "stale" });
  });

  it("reports consecutive failures when a completion is recent", () => {
    const result = evaluateLoopHealth({ lastCompletedAt: minutesAgo(1), recentStatuses: failing, now });
    expect(result).toMatchObject({ unhealthy: true, reason: "consecutive-failures" });
  });

  it("is healthy when a run completed recently and failures are below threshold", () => {
    const result = evaluateLoopHealth({
      lastCompletedAt: minutesAgo(1),
      recentStatuses: ["completed", "failed", "failed"],
      now,
    });
    expect(result).toEqual({ unhealthy: false, reason: null, failures: 0 });
  });
});
