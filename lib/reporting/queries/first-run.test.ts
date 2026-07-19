import { describe, expect, it } from "vitest";

import {
  firstRunPhase,
  isRangeUnlocked,
  observedMs,
  rollupsSinceActivation,
  summarizeCounts,
  uptimeTone,
} from "./first-run";

const now = new Date("2026-07-19T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("firstRunPhase", () => {
  it("is setup before the first success", () => {
    expect(firstRunPhase(null, now)).toBe("setup");
  });

  it("is collecting within the first day of activation", () => {
    expect(firstRunPhase(ago(6 * HOUR), now)).toBe("collecting");
    expect(firstRunPhase(ago(DAY - 1), now)).toBe("collecting");
  });

  it("is active once a full day has been observed", () => {
    expect(firstRunPhase(ago(DAY), now)).toBe("active");
    expect(firstRunPhase(ago(30 * DAY), now)).toBe("active");
  });
});

describe("observedMs", () => {
  it("is zero before activation", () => {
    expect(observedMs(null, now)).toBe(0);
  });

  it("never goes negative when activation is in the future", () => {
    expect(observedMs(new Date(now.getTime() + HOUR), now)).toBe(0);
  });

  it("measures elapsed time since activation", () => {
    expect(observedMs(ago(6 * HOUR), now)).toBe(6 * HOUR);
  });
});

describe("isRangeUnlocked", () => {
  it("keeps every range locked before activation", () => {
    expect(isRangeUnlocked("h24", null, now)).toBe(false);
    expect(isRangeUnlocked("d30", null, now)).toBe(false);
  });

  it("unlocks a range only once its full window is observed", () => {
    expect(isRangeUnlocked("h24", ago(DAY - 1), now)).toBe(false);
    expect(isRangeUnlocked("h24", ago(DAY), now)).toBe(true);
    expect(isRangeUnlocked("d7", ago(6 * DAY), now)).toBe(false);
    expect(isRangeUnlocked("d7", ago(7 * DAY), now)).toBe(true);
    expect(isRangeUnlocked("d30", ago(29 * DAY), now)).toBe(false);
    expect(isRangeUnlocked("d30", ago(30 * DAY), now)).toBe(true);
  });
});

describe("rollupsSinceActivation", () => {
  const row = (iso: string) => ({ bucketStart: new Date(iso) });

  it("returns nothing before activation", () => {
    expect(rollupsSinceActivation([row("2026-07-19T00:00:00Z")], null)).toEqual([]);
  });

  it("excludes the bucket that straddles activation", () => {
    const rows = [
      row("2026-07-19T09:45:00Z"),
      row("2026-07-19T10:00:00Z"),
      row("2026-07-19T10:15:00Z"),
    ];
    // Activation mid-bucket at 10:07 drops the 10:00 bucket whole, since its
    // start precedes activation and it may carry setup failures. Only buckets
    // starting at or after activation survive.
    const result = rollupsSinceActivation(rows, new Date("2026-07-19T10:07:00Z"));
    expect(result.map((entry) => entry.bucketStart.toISOString())).toEqual([
      "2026-07-19T10:15:00.000Z",
    ]);
  });

  it("keeps a bucket whose start equals activation", () => {
    const rows = [row("2026-07-19T10:00:00Z"), row("2026-07-19T10:15:00Z")];
    const result = rollupsSinceActivation(rows, new Date("2026-07-19T10:00:00Z"));
    expect(result.map((entry) => entry.bucketStart.toISOString())).toEqual([
      "2026-07-19T10:00:00.000Z",
      "2026-07-19T10:15:00.000Z",
    ]);
  });

  it("excludes setup failures sharing the activation bucket from observed uptime", () => {
    // Three failures then the first success all land in the 10:00 bucket, then a
    // clean 10:15 bucket follows. Activation at 10:11 sits inside the 10:00
    // bucket, so that bucket drops and its setup failures never count.
    const rows = [
      { bucketStart: new Date("2026-07-19T10:00:00Z"), expectedChecks: 4, completedChecks: 4, successfulChecks: 1, failedChecks: 3 },
      { bucketStart: new Date("2026-07-19T10:15:00Z"), expectedChecks: 4, completedChecks: 4, successfulChecks: 4, failedChecks: 0 },
    ];
    const kept = rollupsSinceActivation(rows, new Date("2026-07-19T10:11:00Z"));
    expect(kept.map((entry) => entry.bucketStart.toISOString())).toEqual([
      "2026-07-19T10:15:00.000Z",
    ]);
    expect(summarizeCounts(kept).uptime).toBe(100);
  });
});

describe("summarizeCounts", () => {
  it("returns null uptime and coverage with no data", () => {
    expect(summarizeCounts([])).toMatchObject({ uptime: null, coverage: null, completed: 0, expected: 0 });
  });

  it("divides success by completed for uptime and completed by expected for coverage", () => {
    const rows = [
      { expectedChecks: 4, completedChecks: 4, successfulChecks: 4, failedChecks: 0 },
      { expectedChecks: 4, completedChecks: 2, successfulChecks: 1, failedChecks: 1 },
    ];
    const summary = summarizeCounts(rows);
    expect(summary.expected).toBe(8);
    expect(summary.completed).toBe(6);
    expect(summary.successful).toBe(5);
    expect(summary.uptime).toBeCloseTo(100 * 5 / 6, 6);
    expect(summary.coverage).toBeCloseTo(6 / 8, 6);
  });

  it("keeps uptime healthy while coverage exposes a stalled scheduler", () => {
    // Every completed check passed, but only a quarter of expected checks ran.
    const summary = summarizeCounts([{ expectedChecks: 96, completedChecks: 24, successfulChecks: 24, failedChecks: 0 }]);
    expect(summary.uptime).toBe(100);
    expect(summary.coverage).toBeCloseTo(0.25, 6);
  });
});

describe("uptimeTone", () => {
  const base = { unlocked: true, currentlyDown: false, recentlyDegraded: false, uptime: 100 };

  it("is collecting while a range is locked, regardless of value", () => {
    expect(uptimeTone({ ...base, unlocked: false, uptime: 42 })).toBe("collecting");
  });

  it("is unknown when there is no completed data", () => {
    expect(uptimeTone({ ...base, uptime: null })).toBe("unknown");
  });

  it("is down only when currently down", () => {
    expect(uptimeTone({ ...base, currentlyDown: true, uptime: 50 })).toBe("down");
  });

  it("is degraded for recent resolution or imperfect history", () => {
    expect(uptimeTone({ ...base, recentlyDegraded: true })).toBe("degraded");
    expect(uptimeTone({ ...base, uptime: 99.5 })).toBe("degraded");
  });

  it("is healthy for a currently up monitor with a clean window", () => {
    expect(uptimeTone({ ...base, uptime: 100 })).toBe("healthy");
    expect(uptimeTone({ ...base, uptime: 99.95 })).toBe("healthy");
  });
});
