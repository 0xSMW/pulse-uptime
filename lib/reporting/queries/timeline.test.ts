import { describe, expect, it } from "vitest";

import {
  blendRawAvailability,
  buildCheckTimeline,
  buildRollupTimeline,
  buildDailyTimeline,
  statusGroupSlug,
  summarizeRollupCoverage,
  type CheckAvailability,
  type RawBucketAvailability,
  type RollupAvailability,
} from "./timeline";

// Deterministic PRNG (mulberry32) so equivalence failures reproduce exactly.
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// These independent reference implementations filter rows for each bucket.
function referenceCheckTimeline(
  rows: CheckAvailability[],
  bucketCount: number,
  durationMs: number,
  now: Date,
) {
  const startMs = now.getTime() - durationMs;
  const width = durationMs / bucketCount;

  return Array.from({ length: bucketCount }, (_, index) => {
    const bucketStart = startMs + index * width;
    const bucketEnd = bucketStart + width;
    const checks = rows.filter((row) => {
      const timestamp = row.checkedAt.getTime();
      return timestamp >= bucketStart && timestamp < bucketEnd;
    });
    const failures = checks.filter((row) => !row.successful).length;
    return {
      state: checks.length === 0
        ? "no-data"
        : failures === 0
          ? "up"
          : failures === checks.length
            ? "down"
            : "verifying",
      label: `${new Date(bucketStart).toISOString()}–${new Date(bucketEnd).toISOString()}`,
      checks: checks.length,
      failures,
      startMs: bucketStart,
      endMs: bucketEnd,
    };
  });
}

function referenceRollupTimeline(
  rows: RollupAvailability[],
  bucketCount: number,
  durationMs: number,
  now: Date,
) {
  const startMs = now.getTime() - durationMs;
  const width = durationMs / bucketCount;

  return Array.from({ length: bucketCount }, (_, index) => {
    const bucketStart = startMs + index * width;
    const bucketEnd = bucketStart + width;
    const included = rows.filter((row) => {
      const timestamp = row.bucketStart.getTime();
      return timestamp >= bucketStart && timestamp < bucketEnd;
    });
    const checks = included.reduce((sum, row) => sum + row.expectedChecks, 0);
    const completed = included.reduce((sum, row) => sum + row.completedChecks, 0);
    const failures = included.reduce((sum, row) => sum + row.failedChecks, 0);
    const downtimeSeconds = included.reduce((sum, row) => sum + row.downtimeSeconds, 0);
    const state = checks === 0 || completed === 0
      ? "no-data"
      : failures === 0 && completed === checks
        ? "up"
        : failures === completed && completed === checks
          ? "down"
          : "verifying";

    return {
      state,
      label: `${new Date(bucketStart).toISOString()}–${new Date(bucketEnd).toISOString()}`,
      checks,
      failures,
      downtimeSeconds,
      startMs: bucketStart,
      endMs: bucketEnd,
    };
  });
}

describe("buildCheckTimeline", () => {
  it("creates a fixed number of chronological buckets", () => {
    const now = new Date("2026-07-18T12:00:00Z");
    const timeline = buildCheckTimeline([
      { checkedAt: new Date("2026-07-18T11:50:00Z"), successful: false },
      { checkedAt: new Date("2026-07-18T11:55:00Z"), successful: true },
    ], 6, 60 * 60 * 1_000, now);

    expect(timeline).toHaveLength(6);
    expect(timeline.at(-1)?.state).toBe("verifying");
  });

  it("produces identical results regardless of input row order", () => {
    const now = new Date("2026-07-18T12:00:00Z");
    const rows = [
      { checkedAt: new Date("2026-07-18T11:20:00Z"), successful: true },
      { checkedAt: new Date("2026-07-18T11:00:00Z"), successful: false },
      { checkedAt: new Date("2026-07-18T11:40:00Z"), successful: true },
    ];

    const forward = buildCheckTimeline(rows, 6, 60 * 60 * 1_000, now);
    const reversed = buildCheckTimeline([...rows].reverse(), 6, 60 * 60 * 1_000, now);

    expect(reversed).toEqual(forward);
  });

  it("excludes checks outside the window", () => {
    const now = new Date("2026-07-18T12:00:00Z");
    const timeline = buildCheckTimeline([
      { checkedAt: new Date("2026-07-18T10:59:59.999Z"), successful: false },
      { checkedAt: new Date("2026-07-18T12:00:00.001Z"), successful: false },
    ], 6, 60 * 60 * 1_000, now);

    expect(timeline.every((bucket) => bucket.checks === 0)).toBe(true);
  });
});

describe("buildDailyTimeline", () => {
  it("fills missing days and classifies daily availability", () => {
    const timeline = buildDailyTimeline([
      { day: "2026-07-16", totalChecks: 10, failedChecks: 0, incidentSeconds: 0 },
      { day: "2026-07-18", totalChecks: 10, failedChecks: 2, incidentSeconds: 80 },
    ], 3, new Date("2026-07-18T12:00:00Z"));

    expect(timeline.map(({ state }) => state)).toEqual(["up", "no-data", "verifying"]);
    expect(timeline[2]?.downtimeSeconds).toBe(80);
  });

  it("carries each day's UTC midnight range as structured start and end times", () => {
    const timeline = buildDailyTimeline([], 2, new Date("2026-07-18T12:00:00Z"));
    expect(timeline[0]?.startMs).toBe(Date.parse("2026-07-17T00:00:00Z"));
    expect(timeline[0]?.endMs).toBe(Date.parse("2026-07-18T00:00:00Z"));
    expect(timeline[1]?.startMs).toBe(Date.parse("2026-07-18T00:00:00Z"));
    expect(timeline[1]?.endMs).toBe(Date.parse("2026-07-19T00:00:00Z"));
  });
});

describe("buildRollupTimeline", () => {
  it("produces identical results for unsorted rows as for sorted rows", () => {
    const now = new Date("2026-07-18T12:00:00Z");
    const rowAt = (iso: string, overrides: Partial<Parameters<typeof buildRollupTimeline>[0][number]> = {}) => ({
      bucketStart: new Date(iso),
      expectedChecks: 4,
      completedChecks: 4,
      successfulChecks: 4,
      failedChecks: 0,
      unknownChecks: 0,
      downtimeSeconds: 0,
      ...overrides,
    });
    const sorted = [
      rowAt("2026-07-18T09:00:00Z"),
      rowAt("2026-07-18T10:00:00Z"),
      rowAt("2026-07-18T11:00:00Z"),
    ];
    const shuffled = [sorted[2]!, sorted[0]!, sorted[1]!];

    const sortedResult = buildRollupTimeline(sorted, 3, 3 * 60 * 60 * 1_000, now);
    const shuffledResult = buildRollupTimeline(shuffled, 3, 3 * 60 * 60 * 1_000, now);

    expect(shuffledResult).toEqual(sortedResult);
    expect(sortedResult.map(({ state }) => state)).toEqual(["up", "up", "up"]);
  });

  it("assigns rows exactly on a bucket boundary to the later bucket, not the earlier one", () => {
    const now = new Date("2026-07-18T12:00:00Z");
    const boundaryRow = {
      bucketStart: new Date("2026-07-18T11:00:00Z"),
      expectedChecks: 4,
      completedChecks: 4,
      successfulChecks: 4,
      failedChecks: 0,
      unknownChecks: 0,
      downtimeSeconds: 0,
    };

    const timeline = buildRollupTimeline([boundaryRow], 2, 2 * 60 * 60 * 1_000, now);

    expect(timeline[0]?.state).toBe("no-data");
    expect(timeline[1]?.state).toBe("up");
  });

  it("aggregates multiple rows that land in the same bucket", () => {
    const now = new Date("2026-07-18T12:00:00Z");
    const timeline = buildRollupTimeline([
      {
        bucketStart: new Date("2026-07-18T11:00:00Z"),
        expectedChecks: 4,
        completedChecks: 4,
        successfulChecks: 4,
        failedChecks: 0,
        unknownChecks: 0,
        downtimeSeconds: 30,
      },
      {
        bucketStart: new Date("2026-07-18T11:15:00Z"),
        expectedChecks: 4,
        completedChecks: 4,
        successfulChecks: 2,
        failedChecks: 2,
        unknownChecks: 0,
        downtimeSeconds: 90,
      },
    ], 1, 60 * 60 * 1_000, now);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ state: "verifying", checks: 8, failures: 2, downtimeSeconds: 120 });
  });

  it("excludes rows outside the requested range, before or after", () => {
    const now = new Date("2026-07-18T12:00:00Z");
    const inRange = {
      bucketStart: new Date("2026-07-18T11:30:00Z"),
      expectedChecks: 4,
      completedChecks: 4,
      successfulChecks: 4,
      failedChecks: 0,
      unknownChecks: 0,
      downtimeSeconds: 0,
    };
    const beforeRange = { ...inRange, bucketStart: new Date("2026-07-18T10:59:59.999Z") };
    const afterRange = { ...inRange, bucketStart: new Date("2026-07-18T12:00:00.001Z") };

    const timeline = buildRollupTimeline([beforeRange, inRange, afterRange], 1, 60 * 60 * 1_000, now);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ checks: 4, failures: 0 });
  });

  it("keeps unknown coverage out of the healthy state", () => {
    const timeline = buildRollupTimeline([
      {
        bucketStart: new Date("2026-07-18T11:00:00Z"),
        expectedChecks: 4,
        completedChecks: 3,
        successfulChecks: 3,
        failedChecks: 0,
        unknownChecks: 1,
        downtimeSeconds: 0,
      },
      {
        bucketStart: new Date("2026-07-18T11:30:00Z"),
        expectedChecks: 4,
        completedChecks: 0,
        successfulChecks: 0,
        failedChecks: 0,
        unknownChecks: 4,
        downtimeSeconds: 0,
      },
    ], 2, 60 * 60 * 1_000, new Date("2026-07-18T12:00:00Z"));

    expect(timeline.map(({ state }) => state)).toEqual(["verifying", "no-data"]);
  });

  it("keeps scheduler gaps out of uptime while exposing coverage", () => {
    expect(summarizeRollupCoverage([
      { expectedChecks: 10, completedChecks: 8, successfulChecks: 8 },
    ])).toEqual({ uptime: 100, coverage: 0.8 });
  });
});

describe("buildRollupTimeline call-site bucket widths", () => {
  // These cases cover the divisible widths used by current reporting call sites.
  it.each([
    ["monitors 24h", 60, 86_400_000],
    ["monitors 7d", 84, 7 * 86_400_000],
    ["monitors 30d", 90, 30 * 86_400_000],
    ["monitors/status 90d", 90, 90 * 86_400_000],
    ["dashboard table 24h", 32, 86_400_000],
  ])("%s: durationMs divides evenly into bucketCount buckets", (_label, bucketCount, durationMs) => {
    expect(durationMs % bucketCount).toBe(0);
  });
});

describe("buildCheckTimeline/buildRollupTimeline equivalence with the reference filter-per-bucket behavior", () => {
  const rand = mulberry32(0xC0FFEE);
  const shuffle = <T,>(items: T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  };

  function randomCheckRows(startMs: number, durationMs: number, count: number): CheckAvailability[] {
    const rows: CheckAvailability[] = [];
    for (let i = 0; i < count; i += 1) {
      // Sample across [start - 20%, start + 120%] of the window so both
      // out-of-range-before and out-of-range-after inputs are exercised.
      const offset = Math.floor((rand() - 0.2) * durationMs * 1.4);
      rows.push({ checkedAt: new Date(startMs + offset), successful: rand() > 0.4 });
    }
    return rows;
  }

  function randomRollupRows(startMs: number, durationMs: number, count: number): RollupAvailability[] {
    const rows: RollupAvailability[] = [];
    for (let i = 0; i < count; i += 1) {
      const offset = Math.floor((rand() - 0.2) * durationMs * 1.4);
      const expectedChecks = 1 + Math.floor(rand() * 4);
      const completedChecks = Math.floor(rand() * (expectedChecks + 1));
      const failedChecks = Math.floor(rand() * (completedChecks + 1));
      rows.push({
        bucketStart: new Date(startMs + offset),
        expectedChecks,
        completedChecks,
        successfulChecks: completedChecks - failedChecks,
        failedChecks,
        unknownChecks: expectedChecks - completedChecks,
        downtimeSeconds: Math.floor(rand() * 60),
      });
    }
    return rows;
  }

  function boundaryCheckRows(startMs: number, width: number, bucketCount: number): CheckAvailability[] {
    const rows: CheckAvailability[] = [];
    for (let index = 0; index <= bucketCount; index += 1) {
      const boundary = startMs + index * width;
      rows.push({ checkedAt: new Date(boundary), successful: index % 2 === 0 });
    }
    rows.push({ checkedAt: new Date(startMs - 1), successful: false });
    rows.push({ checkedAt: new Date(startMs + bucketCount * width + 1), successful: false });
    return rows;
  }

  function boundaryRollupRows(startMs: number, width: number, bucketCount: number): RollupAvailability[] {
    return boundaryCheckRows(startMs, width, bucketCount).map((row, i) => ({
      bucketStart: row.checkedAt,
      expectedChecks: 4,
      completedChecks: 4,
      successfulChecks: row.successful ? 4 : 2,
      failedChecks: row.successful ? 0 : 2,
      unknownChecks: 0,
      downtimeSeconds: i,
    }));
  }

  // Nondivisible cases cover floating-point behavior at bucket boundaries.
  const NON_DIVISIBLE_CASES: Array<[number, number]> = [
    [7, 1_000],
    [3, 100],
    [11, 60_000],
    [13, 86_400_000],
    [9, 604_800_001],
    [6, 1],
    [17, 12_345_678],
  ];
  // Divisible cases cover direct bucket indexing.
  const DIVISIBLE_CASES: Array<[number, number]> = [
    [60, 86_400_000],
    [84, 7 * 86_400_000],
    [90, 30 * 86_400_000],
    [90, 90 * 86_400_000],
  ];

  const now = new Date("2026-07-18T12:00:00.000Z");

  it.each([...NON_DIVISIBLE_CASES, ...DIVISIBLE_CASES])(
    "buildCheckTimeline matches the reference for bucketCount=%d durationMs=%d across random, boundary, and unsorted rows",
    (bucketCount, durationMs) => {
      const startMs = now.getTime() - durationMs;
      const width = durationMs / bucketCount;
      const rows = shuffle([
        ...randomCheckRows(startMs, durationMs, 40),
        ...boundaryCheckRows(startMs, width, bucketCount),
      ]);

      const actual = buildCheckTimeline(rows, bucketCount, durationMs, now);
      const expected = referenceCheckTimeline(rows, bucketCount, durationMs, now);

      expect(actual).toEqual(expected);
    },
  );

  it.each([...NON_DIVISIBLE_CASES, ...DIVISIBLE_CASES])(
    "buildRollupTimeline matches the reference for bucketCount=%d durationMs=%d across random, boundary, and unsorted rows",
    (bucketCount, durationMs) => {
      const startMs = now.getTime() - durationMs;
      const width = durationMs / bucketCount;
      const rows = shuffle([
        ...randomRollupRows(startMs, durationMs, 40),
        ...boundaryRollupRows(startMs, width, bucketCount),
      ]);

      const actual = buildRollupTimeline(rows, bucketCount, durationMs, now);
      const expected = referenceRollupTimeline(rows, bucketCount, durationMs, now);

      expect(actual).toEqual(expected);
    },
  );

  it("matches the reference across many random non-divisible window shapes, not just fixed cases", () => {
    for (let trial = 0; trial < 25; trial += 1) {
      const bucketCount = 2 + Math.floor(rand() * 30);
      const durationMs = 1_000 + Math.floor(rand() * 50_000_000);
      const startMs = now.getTime() - durationMs;
      const width = durationMs / bucketCount;

      const checkRows = shuffle([
        ...randomCheckRows(startMs, durationMs, 25),
        ...boundaryCheckRows(startMs, width, bucketCount),
      ]);
      expect(buildCheckTimeline(checkRows, bucketCount, durationMs, now))
        .toEqual(referenceCheckTimeline(checkRows, bucketCount, durationMs, now));

      const rollupRows = shuffle([
        ...randomRollupRows(startMs, durationMs, 25),
        ...boundaryRollupRows(startMs, width, bucketCount),
      ]);
      expect(buildRollupTimeline(rollupRows, bucketCount, durationMs, now))
        .toEqual(referenceRollupTimeline(rollupRows, bucketCount, durationMs, now));
    }
  });

  it("handles empty input identically for both functions", () => {
    const bucketCount = 7;
    const durationMs = 1_000;
    expect(buildCheckTimeline([], bucketCount, durationMs, now))
      .toEqual(referenceCheckTimeline([], bucketCount, durationMs, now));
    expect(buildRollupTimeline([], bucketCount, durationMs, now))
      .toEqual(referenceRollupTimeline([], bucketCount, durationMs, now));
  });
});

describe("blendRawAvailability", () => {
  const rollupAt = (iso: string, overrides: Partial<RollupAvailability> = {}): RollupAvailability => ({
    bucketStart: new Date(iso),
    expectedChecks: 4,
    completedChecks: 4,
    successfulChecks: 4,
    failedChecks: 0,
    unknownChecks: 0,
    downtimeSeconds: 0,
    ...overrides,
  });
  const rawAt = (iso: string, overrides: Partial<RawBucketAvailability> = {}): RawBucketAvailability =>
    rollupAt(iso, { completedChecks: 1, expectedChecks: 1, successfulChecks: 1, ...overrides });

  it("returns the rollups unchanged when there are no raw buckets", () => {
    const rollups = [rollupAt("2026-07-20T00:00:00Z")];
    expect(blendRawAvailability(rollups, [])).toBe(rollups);
  });

  it("drops a raw bucket whose quarter-hour already has a rollup, so it is never counted twice", () => {
    const rollups = [rollupAt("2026-07-20T00:00:00Z")];
    const raw = [rawAt("2026-07-20T00:00:00Z", { successfulChecks: 0, failedChecks: 1 })];
    const merged = blendRawAvailability(rollups, raw);
    expect(merged).toBe(rollups);
    const timeline = buildRollupTimeline(merged, 1, 15 * 60 * 1_000, new Date("2026-07-20T00:15:00Z"));
    expect(timeline[0]).toMatchObject({ state: "up", checks: 4, failures: 0 });
  });

  it("keeps a raw bucket for a quarter-hour with no rollup, so compaction lag renders instead of no-data", () => {
    const rollups = [rollupAt("2026-07-20T00:00:00Z")];
    const raw = [rawAt("2026-07-20T00:15:00Z")];
    const merged = blendRawAvailability(rollups, raw);
    expect(merged).toHaveLength(2);
    const now = new Date("2026-07-20T00:30:00Z");
    const timeline = buildRollupTimeline(merged, 2, 30 * 60 * 1_000, now);
    expect(timeline.map(({ state }) => state)).toEqual(["up", "up"]);
  });

  it("renders a failing raw-only bucket as down, matching the raw checks it holds", () => {
    const raw = [rawAt("2026-07-20T00:00:00Z", { successfulChecks: 0, failedChecks: 1 })];
    const timeline = buildRollupTimeline(
      blendRawAvailability([], raw), 1, 15 * 60 * 1_000, new Date("2026-07-20T00:15:00Z"),
    );
    expect(timeline[0]).toMatchObject({ state: "down", checks: 1, failures: 1 });
  });

  it("leaves a quarter-hour with neither a rollup nor a raw bucket as no-data", () => {
    const merged = blendRawAvailability([rollupAt("2026-07-20T00:00:00Z")], [rawAt("2026-07-20T00:30:00Z")]);
    const timeline = buildRollupTimeline(merged, 3, 45 * 60 * 1_000, new Date("2026-07-20T00:45:00Z"));
    expect(timeline.map(({ state }) => state)).toEqual(["up", "no-data", "up"]);
  });
});

describe("statusGroupSlug", () => {
  it("creates stable, URL-safe group slugs", () => {
    expect(statusGroupSlug("Primary APIs")).toBe("primary-apis");
    expect(statusGroupSlug("  Édge / EU  ")).toBe("edge-eu");
    expect(statusGroupSlug("服務")).toBe("other");
  });
});
