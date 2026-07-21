import { describe, expect, it } from "vitest"

import { summarizeCounts } from "./first-run"
import {
  buildFirstRun,
  buildLatestIncident,
  buildRecentChecks,
  buildRecentIncidents,
  type LiveIncidentRow,
  type LiveRollupRow,
  observedWithRawTail,
  openingFailure,
  type RawMinuteCheck,
  rawChecksSinceActivation,
  rawTailBounds,
  rollupVersionOf,
  secondsBetween,
} from "./live-summary"

const now = new Date("2026-07-19T12:00:00Z")
const ago = (ms: number) => new Date(now.getTime() - ms)
const DAY = 86_400_000

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
  }
}

function incident(overrides: Partial<LiveIncidentRow>): LiveIncidentRow {
  return {
    id: "inc-1",
    openedAt: ago(2 * 3_600_000),
    resolvedAt: null,
    openingErrorCode: null,
    openingStatusCode: null,
    ...overrides,
  }
}

describe("openingFailure", () => {
  it("prefers the status code", () => {
    expect(openingFailure("ETIMEDOUT", 503)).toBe("HTTP 503")
  })

  it("falls back to the error code then a default", () => {
    expect(openingFailure("ETIMEDOUT", null)).toBe("ETIMEDOUT")
    expect(openingFailure(null, null)).toBe("Unknown failure")
  })
})

describe("secondsBetween", () => {
  it("floors to whole seconds and never goes negative", () => {
    expect(secondsBetween(ago(90_500), now)).toBe(90)
    expect(secondsBetween(now, ago(1000))).toBe(0)
  })
})

describe("rollupVersionOf", () => {
  it("is null with no completed buckets", () => {
    expect(rollupVersionOf([])).toBeNull()
  })

  it("is the last bucket start, which advances with a new bucket", () => {
    const older = rollup({ bucketStart: ago(2 * DAY) })
    const newer = rollup({ bucketStart: ago(DAY) })
    expect(rollupVersionOf([older, newer])).toBe(
      newer.bucketStart.toISOString()
    )
    const advanced = rollup({ bucketStart: ago(DAY - 900_000) })
    expect(rollupVersionOf([older, newer, advanced])).toBe(
      advanced.bucketStart.toISOString()
    )
  })
})

describe("buildLatestIncident", () => {
  it("is null without incidents", () => {
    expect(buildLatestIncident([], now)).toBeNull()
  })

  it("marks an unresolved incident ongoing", () => {
    const result = buildLatestIncident(
      [incident({ resolvedAt: null, openingStatusCode: 500 })],
      now
    )
    expect(result).toMatchObject({
      state: "ONGOING",
      openingFailure: "HTTP 500",
      resolvedAt: null,
    })
  })

  it("keeps a resolution inside the last day and drops an older one", () => {
    const recent = buildLatestIncident(
      [incident({ resolvedAt: ago(3_600_000) })],
      now
    )
    expect(recent).toMatchObject({ state: "RESOLVED" })
    const stale = buildLatestIncident(
      [incident({ resolvedAt: ago(2 * DAY) })],
      now
    )
    expect(stale).toBeNull()
  })
})

describe("buildRecentIncidents", () => {
  it("maps every row with a duration to now for unresolved ones", () => {
    const rows = [
      incident({ id: "a", openedAt: ago(3_600_000), resolvedAt: null }),
      incident({
        id: "b",
        openedAt: ago(2 * DAY),
        resolvedAt: ago(2 * DAY - 600_000),
        openingStatusCode: 502,
      }),
    ]
    const mapped = buildRecentIncidents(rows, now)
    expect(mapped).toHaveLength(2)
    expect(mapped[0]).toMatchObject({
      id: "a",
      durationSeconds: 3600,
      openingFailure: "Unknown failure",
    })
    expect(mapped[1]).toMatchObject({
      id: "b",
      durationSeconds: 600,
      openingFailure: "HTTP 502",
    })
  })
})

describe("buildRecentChecks", () => {
  it("takes the last twenty buckets newest first", () => {
    const rows = Array.from({ length: 25 }, (_, index) =>
      rollup({ bucketStart: ago((25 - index) * 900_000) })
    )
    const checks = buildRecentChecks(rows)
    expect(checks).toHaveLength(20)
    expect(checks[0]!.checkedAt).toBe(rows.at(-1)!.bucketStart.toISOString())
  })

  it("labels coverage gaps, failures, and healthy rollups", () => {
    const unknown = buildRecentChecks([
      rollup({ completedChecks: 10, unknownChecks: 5 }),
    ])[0]!
    expect(unknown).toMatchObject({
      successful: false,
      resultLabel: "Unknown coverage",
    })
    const failed = buildRecentChecks([
      rollup({ failedChecks: 3, completedChecks: 15 }),
    ])[0]!
    expect(failed).toMatchObject({
      successful: false,
      resultLabel: "Failed checks",
    })
    const healthy = buildRecentChecks([rollup({})])[0]!
    expect(healthy).toMatchObject({
      successful: true,
      resultLabel: "Healthy rollup",
      latencyMs: 100,
    })
  })

  it("reports null latency when no samples were recorded", () => {
    expect(
      buildRecentChecks([rollup({ latencyCount: 0, latencySumMs: 0n })])[0]!
        .latencyMs
    ).toBeNull()
  })
})

describe("rawChecksSinceActivation", () => {
  const check = (overrides: Partial<RawMinuteCheck>): RawMinuteCheck => ({
    checked_at: ago(DAY),
    completed: true,
    failed: false,
    latency_ms: 90,
    ...overrides,
  })
  const activatedAt = ago(6 * 3_600_000)

  it("drops a check before activation and keeps one at or after it", () => {
    const before = check({ checked_at: ago(12 * 3_600_000), failed: true })
    const atCutoff = check({ checked_at: activatedAt })
    const after = check({ checked_at: ago(3_600_000) })

    const kept = rawChecksSinceActivation(
      [before, atCutoff, after],
      activatedAt
    )

    expect(kept).toEqual([atCutoff, after])
  })

  it("keeps the activation-minute check when activation stamped a few seconds in", () => {
    // activated_at is the real completion instant a few seconds past the minute,
    // while the raw check_at is the minute-aligned scheduled minute. Flooring
    // activation to its minute keeps the activating success, and a prior-minute
    // setup failure stays excluded.
    const activated = new Date("2026-07-19T06:00:05.000Z")
    const atMinute = check({ checked_at: new Date("2026-07-19T06:00:00.000Z") })
    const priorMinute = check({
      checked_at: new Date("2026-07-19T05:59:00.000Z"),
      failed: true,
    })

    const kept = rawChecksSinceActivation([priorMinute, atMinute], activated)

    expect(kept).toEqual([atMinute])
  })

  it("returns an empty array for an unactivated monitor", () => {
    expect(rawChecksSinceActivation([check({})], null)).toEqual([])
  })
})

describe("rawTailBounds", () => {
  it("is null for an unactivated monitor", () => {
    expect(rawTailBounds([], null)).toBeNull()
  })

  it("floors activation to its minute and leaves both middle bounds absent with no counted bucket", () => {
    const activatedAt = new Date("2026-07-19T12:03:05.000Z")
    expect(rawTailBounds([], activatedAt)).toEqual({
      activationFloor: new Date("2026-07-19T12:03:00.000Z"),
      firstCountedBucketStart: null,
      lastCompletedBucketEnd: null,
    })
  })

  it("carves the counted middle out of the raw contribution once a bucket compacts", () => {
    // Activated 12:03:05, so rollupsSinceActivation excludes the 12:00 straddling
    // bucket and counts from 12:15. The bounds keep the straddling tail before
    // 12:15 and the uncompacted tail at or after the 12:15 bucket end 12:30, so no
    // post-activation minute drops and the counted middle never folds twice.
    const activatedAt = new Date("2026-07-19T12:03:05.000Z")
    const rollups = [{ bucketStart: new Date("2026-07-19T12:15:00.000Z") }]
    expect(rawTailBounds(rollups, activatedAt)).toEqual({
      activationFloor: new Date("2026-07-19T12:03:00.000Z"),
      firstCountedBucketStart: new Date("2026-07-19T12:15:00.000Z"),
      lastCompletedBucketEnd: new Date("2026-07-19T12:30:00.000Z"),
    })
  })

  it("spans first counted start to last counted end across several buckets", () => {
    const activatedAt = new Date("2026-07-19T06:00:00.000Z")
    const rollups = [
      { bucketStart: new Date("2026-07-19T11:30:00.000Z") },
      { bucketStart: new Date("2026-07-19T11:45:00.000Z") },
    ]
    expect(rawTailBounds(rollups, activatedAt)).toEqual({
      activationFloor: new Date("2026-07-19T06:00:00.000Z"),
      firstCountedBucketStart: new Date("2026-07-19T11:30:00.000Z"),
      lastCompletedBucketEnd: new Date("2026-07-19T12:00:00.000Z"),
    })
  })
})

describe("observed counts hold across compaction of the straddling bucket", () => {
  // A monitor activated 12:03:05 on a one-minute cadence. The 12:00 straddling
  // bucket holds pre-activation setup failures plus the post-activation successes
  // 12:03 through 12:14. rollupsSinceActivation excludes that whole bucket.
  const activatedAt = new Date("2026-07-19T12:03:05.000Z")
  // Twelve post-activation minutes 12:03 through 12:14 all succeed.
  const straddlingTail = {
    expected: 12,
    completed: 12,
    successful: 12,
    failed: 0,
  }

  it("counts the straddling tail before compaction with no counted rollup", () => {
    const bounds = rawTailBounds([], activatedAt)
    expect(bounds).toEqual({
      activationFloor: new Date("2026-07-19T12:03:00.000Z"),
      firstCountedBucketStart: null,
      lastCompletedBucketEnd: null,
    })
    // With no counted rollup the aggregate scans the single interval and folds
    // the whole straddling tail onto empty base counts.
    const observed = observedWithRawTail([], straddlingTail)
    expect(observed).toMatchObject({
      expected: 12,
      completed: 12,
      successful: 12,
      uptime: 100,
    })
  })

  it("still counts the straddling tail after the 12:15 bucket compacts and does not drop", () => {
    // The 12:15 bucket compacts. rollupsSinceActivation counts it, and the raw
    // aggregate now scans [12:03, 12:15) plus [12:30, now), still folding the same
    // twelve straddling-tail minutes since they sit before firstCountedBucketStart.
    const counted = [
      {
        bucketStart: new Date("2026-07-19T12:15:00.000Z"),
        expectedChecks: 15,
        completedChecks: 15,
        successfulChecks: 15,
        failedChecks: 0,
      },
    ]
    const bounds = rawTailBounds(counted, activatedAt)
    expect(bounds).toMatchObject({
      activationFloor: new Date("2026-07-19T12:03:00.000Z"),
      firstCountedBucketStart: new Date("2026-07-19T12:15:00.000Z"),
      lastCompletedBucketEnd: new Date("2026-07-19T12:30:00.000Z"),
    })
    // The straddling tail sits in [12:03, 12:15), so the aggregate keeps counting
    // it while the 12:15 bucket carries the middle. Expected does not drop from the
    // pre-compaction 12, it rises to 12 + 15, and the compacted middle is not
    // double counted.
    const observed = observedWithRawTail(counted, straddlingTail)
    expect(observed).toMatchObject({
      expected: 27,
      completed: 27,
      successful: 27,
      uptime: 100,
    })
    expect(observed.expected).toBeGreaterThanOrEqual(12)
  })
})

describe("observedWithRawTail", () => {
  const completedRollup = (
    overrides: Partial<{
      expectedChecks: number
      completedChecks: number
      successfulChecks: number
      failedChecks: number
    }>
  ) => ({
    expectedChecks: 15,
    completedChecks: 15,
    successfulChecks: 15,
    failedChecks: 0,
    ...overrides,
  })

  it("counts the tail alone when no rollup has compacted yet", () => {
    const observed = observedWithRawTail([], {
      expected: 3,
      completed: 3,
      successful: 3,
      failed: 0,
    })
    expect(observed).toMatchObject({
      expected: 3,
      completed: 3,
      successful: 3,
      uptime: 100,
    })
    expect(observed.coverage).toBe(1)
  })

  it("sums the completed rollup counts with the uncompacted tail counts", () => {
    const rollups = [completedRollup({})]
    const observed = observedWithRawTail(rollups, {
      expected: 2,
      completed: 2,
      successful: 2,
      failed: 0,
    })
    expect(observed).toMatchObject({
      expected: 17,
      completed: 17,
      successful: 17,
      uptime: 100,
    })
  })

  it("holds the base counts when the tail is empty", () => {
    const rollups = [
      completedRollup({
        expectedChecks: 14,
        completedChecks: 14,
        successfulChecks: 14,
      }),
    ]
    const observed = observedWithRawTail(rollups, {
      expected: 0,
      completed: 0,
      successful: 0,
      failed: 0,
    })
    expect(observed).toMatchObject({
      expected: 14,
      completed: 14,
      successful: 14,
    })
  })

  it("keeps tail coverage honest for an unknown minute and never exceeds 100 uptime", () => {
    const observed = observedWithRawTail([], {
      expected: 3,
      completed: 2,
      successful: 1,
      failed: 1,
    })
    expect(observed.expected).toBe(3)
    expect(observed.completed).toBe(2)
    expect(observed.successful).toBe(1)
    expect(observed.failed).toBe(1)
    expect(observed.uptime).toBe(50)
    expect(observed.coverage).toBeCloseTo(2 / 3)
  })
})

describe("buildFirstRun", () => {
  const identity = {
    activatedAt: null as Date | null,
    consecutiveFailures: 0 as number | null,
    lastErrorCode: null as string | null,
    lastStatusCode: null as number | null,
    lastCheckedAt: null as Date | null,
  }

  it("is setup with a surfaced last failure before activation", () => {
    const observed = summarizeCounts([])
    const result = buildFirstRun(
      {
        ...identity,
        consecutiveFailures: 2,
        lastStatusCode: 500,
        lastCheckedAt: ago(60_000),
      },
      observed,
      now
    )
    expect(result).toMatchObject({
      phase: "setup",
      setupError: "HTTP 500",
      activatedAt: null,
    })
    expect(result.lastCheckedAt).toBe(ago(60_000).toISOString())
  })

  it("has no setup error once activated and carries observed counts", () => {
    const observed = summarizeCounts([
      {
        expectedChecks: 20,
        completedChecks: 18,
        successfulChecks: 18,
        failedChecks: 0,
      },
    ])
    const result = buildFirstRun(
      { ...identity, activatedAt: ago(6 * 3_600_000) },
      observed,
      now
    )
    expect(result).toMatchObject({ phase: "collecting", setupError: null })
    expect(result.observed).toEqual({
      uptime: 100,
      completed: 18,
      expected: 20,
    })
    expect(result.observedSeconds).toBe(6 * 3600)
  })
})
