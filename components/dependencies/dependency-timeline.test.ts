import { describe, expect, it } from "vitest"

import { mapDependencyBucketsToTimeline } from "./dependency-timeline"

const HOUR_MS = 3_600_000

describe("mapDependencyBucketsToTimeline", () => {
  it("maps each dependency state onto its TimelineBar bucket state", () => {
    const buckets = mapDependencyBucketsToTimeline(
      [
        { start: "2026-07-19T00:00:00.000Z", state: "OPERATIONAL" },
        { start: "2026-07-19T01:00:00.000Z", state: "DEGRADED" },
        { start: "2026-07-19T02:00:00.000Z", state: "OUTAGE" },
        { start: "2026-07-19T03:00:00.000Z", state: "MAINTENANCE" },
        { start: "2026-07-19T04:00:00.000Z", state: "UNKNOWN" },
        { start: "2026-07-19T05:00:00.000Z", state: null },
      ],
      HOUR_MS
    )
    expect(buckets.map((bucket) => bucket.state)).toEqual([
      "up",
      "verifying",
      "down",
      "paused",
      "no-data",
      "no-data",
    ])
  })

  it("labels each bucket with its covered ISO range", () => {
    const [bucket] = mapDependencyBucketsToTimeline(
      [{ start: "2026-07-19T00:00:00.000Z", state: "OPERATIONAL" }],
      HOUR_MS
    )
    expect(bucket.label).toBe(
      "2026-07-19T00:00:00.000Z–2026-07-19T01:00:00.000Z"
    )
  })

  it("only counts a failure for OUTAGE buckets, and no check for buckets with no state", () => {
    const buckets = mapDependencyBucketsToTimeline(
      [
        { start: "2026-07-19T00:00:00.000Z", state: "OUTAGE" },
        { start: "2026-07-19T01:00:00.000Z", state: "OPERATIONAL" },
        { start: "2026-07-19T02:00:00.000Z", state: null },
      ],
      HOUR_MS
    )
    expect(buckets.map((bucket) => [bucket.checks, bucket.failures])).toEqual([
      [1, 1],
      [1, 0],
      [0, 0],
    ])
  })

  it("uses the given bucket width to compute each range's end, e.g. a 7d daily bucket", () => {
    const DAY_MS = 86_400_000
    const [bucket] = mapDependencyBucketsToTimeline(
      [{ start: "2026-07-19T00:00:00.000Z", state: "OPERATIONAL" }],
      DAY_MS
    )
    expect(bucket.label).toBe(
      "2026-07-19T00:00:00.000Z–2026-07-20T00:00:00.000Z"
    )
  })
})
