import { describe, expect, it } from "vitest";

/**
 * Ranges based on acceptedAt must select the same snapshot as ordering eligible
 * snapshots by acceptedAt and seenAt for each minute.
 */

interface Snapshot {
  configVersion: number;
  acceptedAt: number;
  seenAt: number;
}

function selectByPerMinuteOrderByLimit1(snapshots: readonly Snapshot[], minute: number): number | undefined {
  const candidates = snapshots.filter((snapshot) => snapshot.acceptedAt <= minute);
  if (candidates.length === 0) return undefined;
  const sorted = [...candidates].sort((a, b) => b.acceptedAt - a.acceptedAt || b.seenAt - a.seenAt);
  return sorted[0]!.configVersion;
}

function buildAcceptedRanges(snapshots: readonly Snapshot[]) {
  const winnerByAcceptedAt = new Map<number, Snapshot>();
  for (const snapshot of snapshots) {
    const current = winnerByAcceptedAt.get(snapshot.acceptedAt);
    if (!current || snapshot.seenAt > current.seenAt) {
      winnerByAcceptedAt.set(snapshot.acceptedAt, snapshot);
    }
  }
  const distinctAcceptedAtsAsc = [...winnerByAcceptedAt.keys()].sort((a, b) => a - b);
  return distinctAcceptedAtsAsc.map((acceptedAt, index) => ({
    configVersion: winnerByAcceptedAt.get(acceptedAt)!.configVersion,
    acceptedAt,
    nextAcceptedAt: distinctAcceptedAtsAsc[index + 1] ?? null,
  }));
}

function selectByPrecomputedRange(
  ranges: ReturnType<typeof buildAcceptedRanges>,
  minute: number,
): number | undefined {
  const match = ranges.find(
    (range) => range.acceptedAt <= minute && (range.nextAcceptedAt === null || minute < range.nextAcceptedAt),
  );
  return match?.configVersion;
}

function expectEquivalentAcrossMinutes(snapshots: readonly Snapshot[], minutes: readonly number[]) {
  const ranges = buildAcceptedRanges(snapshots);
  for (const minute of minutes) {
    expect(selectByPrecomputedRange(ranges, minute)).toBe(selectByPerMinuteOrderByLimit1(snapshots, minute));
  }
}

describe("scheduler gap accepted-config selection equivalence", () => {
  it("agrees when there are no accepted snapshots at all", () => {
    expectEquivalentAcrossMinutes([], [0, 100, -100]);
  });

  it("agrees before the earliest accepted_at (no config effective yet)", () => {
    const snapshots: Snapshot[] = [{ configVersion: 1, acceptedAt: 100, seenAt: 100 }];
    expectEquivalentAcrossMinutes(snapshots, [0, 50, 99]);
  });

  it("agrees exactly at an accepted_at boundary (inclusive lower bound)", () => {
    const snapshots: Snapshot[] = [
      { configVersion: 1, acceptedAt: 100, seenAt: 100 },
      { configVersion: 2, acceptedAt: 200, seenAt: 200 },
    ];
    expectEquivalentAcrossMinutes(snapshots, [100, 199, 200, 201]);
  });

  it("agrees on the minute immediately before the next accepted_at (exclusive upper bound)", () => {
    const snapshots: Snapshot[] = [
      { configVersion: 1, acceptedAt: 100, seenAt: 100 },
      { configVersion: 2, acceptedAt: 101, seenAt: 100 },
    ];
    expectEquivalentAcrossMinutes(snapshots, [99, 100, 101, 102]);
  });

  it("breaks ties on identical accepted_at by the greatest seen_at", () => {
    const snapshots: Snapshot[] = [
      { configVersion: 1, acceptedAt: 100, seenAt: 100 },
      { configVersion: 2, acceptedAt: 100, seenAt: 300 },
      { configVersion: 3, acceptedAt: 100, seenAt: 200 },
    ];
    expect(selectByPerMinuteOrderByLimit1(snapshots, 150)).toBe(2);
    expectEquivalentAcrossMinutes(snapshots, [100, 150]);
  });

  it("agrees across many distinct accepted_at values and out-of-order insertion", () => {
    const snapshots: Snapshot[] = [
      { configVersion: 5, acceptedAt: 500, seenAt: 500 },
      { configVersion: 1, acceptedAt: 100, seenAt: 150 },
      { configVersion: 3, acceptedAt: 300, seenAt: 300 },
      { configVersion: 2, acceptedAt: 200, seenAt: 250 },
      { configVersion: 4, acceptedAt: 400, seenAt: 400 },
    ];
    const minutes = [0, 99, 100, 150, 199, 200, 299, 300, 399, 400, 499, 500, 999];
    expectEquivalentAcrossMinutes(snapshots, minutes);
  });

  it("agrees with duplicate accepted_at groups scattered between distinct boundaries", () => {
    const snapshots: Snapshot[] = [
      { configVersion: 1, acceptedAt: 100, seenAt: 10 },
      { configVersion: 2, acceptedAt: 100, seenAt: 20 },
      { configVersion: 3, acceptedAt: 250, seenAt: 5 },
      { configVersion: 4, acceptedAt: 250, seenAt: 15 },
      { configVersion: 5, acceptedAt: 250, seenAt: 10 },
      { configVersion: 6, acceptedAt: 400, seenAt: 1 },
    ];
    const minutes = [50, 100, 200, 249, 250, 300, 399, 400, 500];
    expectEquivalentAcrossMinutes(snapshots, minutes);
  });

  it("agrees across a randomized fuzz sweep of accepted_at/seen_at combinations", () => {
    let seed = 42;
    const nextRandom = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const snapshots: Snapshot[] = Array.from({ length: 60 }, (_, index) => ({
      configVersion: index,
      acceptedAt: Math.floor(nextRandom() * 20) * 10,
      seenAt: Math.floor(nextRandom() * 1000),
    }));
    const minutes = Array.from({ length: 250 }, () => Math.floor(nextRandom() * 250));
    expectEquivalentAcrossMinutes(snapshots, minutes);
  });
});
