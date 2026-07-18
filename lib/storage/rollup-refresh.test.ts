import { describe, expect, it } from "vitest";

import {
  completesQuarterHourBucket,
  refreshRecentRollups,
  ROLLUP_COVERED_UNTIL_SQL,
  ROLLUP_REFRESH_MAX_LOOKBACK_MS,
  ROLLUP_REFRESH_MIN_LOOKBACK_MS,
} from "./rollup-refresh";
import { COMPACT_15_MINUTE_SQL, PROMOTE_ROLLUP_SQL } from "./sql";

function recordingExecutor(coveredUntil: Date | null) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  return {
    calls,
    async query<T>(text: string, values: readonly unknown[]): Promise<readonly T[]> {
      calls.push({ text, values });
      if (text === ROLLUP_COVERED_UNTIL_SQL) {
        return [{ covered_until: coveredUntil }] as unknown as readonly T[];
      }
      return [];
    },
  };
}

describe("completesQuarterHourBucket", () => {
  it("fires on the last minute of each quarter-hour bucket", () => {
    expect(completesQuarterHourBucket(new Date("2026-07-18T12:14:00.000Z"))).toBe(true);
    expect(completesQuarterHourBucket(new Date("2026-07-18T12:29:00.000Z"))).toBe(true);
    expect(completesQuarterHourBucket(new Date("2026-07-18T12:44:00.000Z"))).toBe(true);
    expect(completesQuarterHourBucket(new Date("2026-07-18T12:59:00.000Z"))).toBe(true);
  });

  it("stays quiet on every other minute", () => {
    expect(completesQuarterHourBucket(new Date("2026-07-18T12:00:00.000Z"))).toBe(false);
    expect(completesQuarterHourBucket(new Date("2026-07-18T12:15:00.000Z"))).toBe(false);
    expect(completesQuarterHourBucket(new Date("2026-07-18T12:37:00.000Z"))).toBe(false);
  });
});

describe("refreshRecentRollups", () => {
  const scheduledMinute = new Date("2026-07-18T12:59:00.000Z");
  const now = new Date("2026-07-18T12:59:07.000Z");
  const end = new Date("2026-07-18T13:00:00.000Z");

  it("compacts then promotes over the recent window when coverage is current", async () => {
    const db = recordingExecutor(new Date("2026-07-18T12:45:00.000Z"));
    await refreshRecentRollups(db, scheduledMinute, now);

    const start = new Date(end.getTime() - ROLLUP_REFRESH_MIN_LOOKBACK_MS);
    expect(db.calls.map((call) => call.text)).toEqual([
      ROLLUP_COVERED_UNTIL_SQL,
      COMPACT_15_MINUTE_SQL,
      PROMOTE_ROLLUP_SQL,
      PROMOTE_ROLLUP_SQL,
    ]);
    expect(db.calls[1]!.values).toEqual([start, end, now]);
    expect(db.calls[2]!.values).toEqual(["15m", "hour", start, end]);
    expect(db.calls[3]!.values).toEqual(["hour", "day", start, end]);
  });

  it("reaches back to the coverage gap after an outage", async () => {
    const coveredUntil = new Date("2026-07-18T04:00:00.000Z");
    const db = recordingExecutor(coveredUntil);
    await refreshRecentRollups(db, scheduledMinute, now);
    expect(db.calls[1]!.values[0]).toEqual(coveredUntil);
  });

  it("caps the backfill window when coverage is missing entirely", async () => {
    const db = recordingExecutor(null);
    await refreshRecentRollups(db, scheduledMinute, now);
    expect(db.calls[1]!.values[0]).toEqual(new Date(end.getTime() - ROLLUP_REFRESH_MAX_LOOKBACK_MS));
  });
});
