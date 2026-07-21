import { describe, expect, it } from "vitest"

import {
  type BackfillIncident,
  buildStateBuckets,
  type IntervalRow,
  incidentImpactState,
} from "./buckets"

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const NOW = new Date("2026-07-19T12:00:00.000Z")

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs)
}

describe("incidentImpactState", () => {
  it("maps critical and major impacts to OUTAGE", () => {
    expect(incidentImpactState("critical")).toBe("OUTAGE")
    expect(incidentImpactState("major")).toBe("OUTAGE")
    expect(incidentImpactState("CRITICAL")).toBe("OUTAGE")
  })

  it("maps a maintenance impact to MAINTENANCE", () => {
    expect(incidentImpactState("maintenance")).toBe("MAINTENANCE")
  })

  it("maps minor, null, and unrecognized impacts to DEGRADED", () => {
    expect(incidentImpactState("minor")).toBe("DEGRADED")
    expect(incidentImpactState(null)).toBe("DEGRADED")
    expect(incidentImpactState("SERVICE_DISRUPTION")).toBe("DEGRADED")
  })

  it("maps an explicit none impact to OPERATIONAL, case-insensitively", () => {
    expect(incidentImpactState("none")).toBe("OPERATIONAL")
    expect(incidentImpactState("None")).toBe("OPERATIONAL")
    expect(incidentImpactState("NONE")).toBe("OPERATIONAL")
  })
})

describe("buildStateBuckets without backfill", () => {
  it("leaves buckets with no overlapping interval null", () => {
    const buckets = buildStateBuckets([], 4, HOUR_MS, NOW)
    expect(buckets.map((bucket) => bucket.state)).toEqual([
      null,
      null,
      null,
      null,
    ])
  })

  it("picks the worst overlapping interval state per bucket", () => {
    const intervals: IntervalRow[] = [
      { state: "OPERATIONAL", startedAt: at(-4 * HOUR_MS), endedAt: null },
      {
        state: "OUTAGE",
        startedAt: at(-3 * HOUR_MS),
        endedAt: at(-2 * HOUR_MS),
      },
    ]
    const buckets = buildStateBuckets(intervals, 4, HOUR_MS, NOW)
    // Window is [NOW-4h, NOW]. The OUTAGE covers the second bucket only.
    expect(buckets.map((bucket) => bucket.state)).toEqual([
      "OPERATIONAL",
      "OUTAGE",
      "OPERATIONAL",
      "OPERATIONAL",
    ])
  })
})

describe("buildStateBuckets with assumed-operational backfill", () => {
  it("assumes operational for pre-install buckets with no interval", () => {
    const buckets = buildStateBuckets([], 4, HOUR_MS, NOW, {
      createdAt: NOW,
      incidents: [],
    })
    expect(buckets.map((bucket) => bucket.state)).toEqual([
      "OPERATIONAL",
      "OPERATIONAL",
      "OPERATIONAL",
      "OPERATIONAL",
    ])
  })

  it("raises an assumed bucket to a matched incident's state where it overlaps", () => {
    const incidents: BackfillIncident[] = [
      {
        startedAt: at(-3 * HOUR_MS),
        resolvedAt: at(-2 * HOUR_MS),
        state: "OUTAGE",
      },
    ]
    const buckets = buildStateBuckets([], 4, HOUR_MS, NOW, {
      createdAt: NOW,
      incidents,
    })
    // Incident covers [NOW-3h, NOW-2h], which is the second bucket only.
    expect(buckets.map((bucket) => bucket.state)).toEqual([
      "OPERATIONAL",
      "OUTAGE",
      "OPERATIONAL",
      "OPERATIONAL",
    ])
  })

  it("carries an open-ended incident forward to the render edge", () => {
    const incidents: BackfillIncident[] = [
      { startedAt: at(-2.5 * HOUR_MS), resolvedAt: null, state: "DEGRADED" },
    ]
    const buckets = buildStateBuckets([], 4, HOUR_MS, NOW, {
      createdAt: NOW,
      incidents,
    })
    expect(buckets.map((bucket) => bucket.state)).toEqual([
      "OPERATIONAL",
      "DEGRADED",
      "DEGRADED",
      "DEGRADED",
    ])
  })

  it("surfaces a pre-install incident on a bucket that straddles createdAt", () => {
    // createdAt sits mid third bucket. The opening interval covers the part
    // at or after it, and an incident sits in the part before it.
    const intervals: IntervalRow[] = [
      { state: "OPERATIONAL", startedAt: at(-1.5 * HOUR_MS), endedAt: null },
    ]
    const incidents: BackfillIncident[] = [
      {
        startedAt: at(-2 * HOUR_MS),
        resolvedAt: at(-1.75 * HOUR_MS),
        state: "OUTAGE",
      },
    ]
    const buckets = buildStateBuckets(intervals, 4, HOUR_MS, NOW, {
      createdAt: at(-1.5 * HOUR_MS),
      incidents,
    })
    // Buckets [NOW-4h..NOW-2h] assumed operational, the straddling third
    // bucket [NOW-2h, NOW-1h] takes the incident's OUTAGE, the last is the
    // interval's OPERATIONAL.
    expect(buckets.map((bucket) => bucket.state)).toEqual([
      "OPERATIONAL",
      "OPERATIONAL",
      "OUTAGE",
      "OPERATIONAL",
    ])
  })

  it("paints only the in-window portion of an incident straddling the 7d left edge", () => {
    const incidents: BackfillIncident[] = [
      {
        startedAt: at(-9 * DAY_MS),
        resolvedAt: at(-6.5 * DAY_MS),
        state: "OUTAGE",
      },
    ]
    const buckets = buildStateBuckets([], 7, DAY_MS, NOW, {
      createdAt: NOW,
      incidents,
    })
    // 7 daily buckets over [NOW-7d, NOW], assumed window [NOW-7d, NOW). The
    // incident reaches into the first bucket only.
    expect(buckets.map((bucket) => bucket.state)).toEqual([
      "OUTAGE",
      "OPERATIONAL",
      "OPERATIONAL",
      "OPERATIONAL",
      "OPERATIONAL",
      "OPERATIONAL",
      "OPERATIONAL",
    ])
  })

  it("keeps buckets entirely before createdAt - 7d grey", () => {
    // A 14-day window with an install 2 days old: buckets older than
    // createdAt - 7d carry no assumption and stay null.
    const buckets = buildStateBuckets([], 14, DAY_MS, NOW, {
      createdAt: at(-2 * DAY_MS),
      incidents: [],
    })
    const states = buckets.map((bucket) => bucket.state)
    // assumed window is [NOW-9d, NOW-2d). Buckets whose end is at or before
    // NOW-9d stay null, and buckets at or after createdAt have no interval so
    // they are null too.
    expect(states.slice(0, 5)).toEqual([null, null, null, null, null])
    expect(states.slice(5, 12)).toEqual([
      "OPERATIONAL",
      "OPERATIONAL",
      "OPERATIONAL",
      "OPERATIONAL",
      "OPERATIONAL",
      "OPERATIONAL",
      "OPERATIONAL",
    ])
    expect(states.slice(12)).toEqual([null, null])
  })

  it("leaves a dependency older than the window unaffected by the overlay", () => {
    const intervals: IntervalRow[] = [
      { state: "OPERATIONAL", startedAt: at(-30 * DAY_MS), endedAt: null },
    ]
    const incidents: BackfillIncident[] = [
      {
        startedAt: at(-2 * HOUR_MS),
        resolvedAt: at(-1 * HOUR_MS),
        state: "OUTAGE",
      },
    ]
    const buckets = buildStateBuckets(intervals, 4, HOUR_MS, NOW, {
      createdAt: at(-30 * DAY_MS),
      incidents,
    })
    // createdAt is far in the past, so no bucket is in the assumed window and
    // the overlay incident is ignored: pure interval behavior.
    expect(buckets.map((bucket) => bucket.state)).toEqual([
      "OPERATIONAL",
      "OPERATIONAL",
      "OPERATIONAL",
      "OPERATIONAL",
    ])
  })

  it("keeps a matched none-impact incident green in the assumed window", () => {
    const incidents: BackfillIncident[] = [
      {
        startedAt: at(-3 * HOUR_MS),
        resolvedAt: at(-2 * HOUR_MS),
        state: incidentImpactState("none"),
      },
    ]
    const buckets = buildStateBuckets([], 4, HOUR_MS, NOW, {
      createdAt: NOW,
      incidents,
    })
    // The none-impact incident contributes OPERATIONAL, so every assumed
    // bucket stays green even where the incident overlaps.
    expect(buckets.map((bucket) => bucket.state)).toEqual([
      "OPERATIONAL",
      "OPERATIONAL",
      "OPERATIONAL",
      "OPERATIONAL",
    ])
  })

  it("lets a null-impact incident still floor an assumed bucket to DEGRADED", () => {
    const incidents: BackfillIncident[] = [
      {
        startedAt: at(-3 * HOUR_MS),
        resolvedAt: at(-2 * HOUR_MS),
        state: incidentImpactState(null),
      },
    ]
    const buckets = buildStateBuckets([], 4, HOUR_MS, NOW, {
      createdAt: NOW,
      incidents,
    })
    expect(buckets.map((bucket) => bucket.state)).toEqual([
      "OPERATIONAL",
      "DEGRADED",
      "OPERATIONAL",
      "OPERATIONAL",
    ])
  })

  it("never lets a none-impact incident downgrade a worse overlapping state", () => {
    const incidents: BackfillIncident[] = [
      {
        startedAt: at(-3 * HOUR_MS),
        resolvedAt: at(-2 * HOUR_MS),
        state: incidentImpactState("critical"),
      },
      {
        startedAt: at(-3 * HOUR_MS),
        resolvedAt: at(-2 * HOUR_MS),
        state: incidentImpactState("none"),
      },
    ]
    const buckets = buildStateBuckets([], 4, HOUR_MS, NOW, {
      createdAt: NOW,
      incidents,
    })
    // The overlapping critical incident wins the bucket, the none-impact one
    // adds only an OPERATIONAL contribution that cannot lift it back to green.
    expect(buckets.map((bucket) => bucket.state)).toEqual([
      "OPERATIONAL",
      "OUTAGE",
      "OPERATIONAL",
      "OPERATIONAL",
    ])
  })

  it("never lets the operational floor mask a worse real interval state", () => {
    const intervals: IntervalRow[] = [
      { state: "UNKNOWN", startedAt: at(-4 * HOUR_MS), endedAt: null },
    ]
    const buckets = buildStateBuckets(intervals, 4, HOUR_MS, NOW, {
      createdAt: NOW,
      incidents: [],
    })
    expect(buckets.map((bucket) => bucket.state)).toEqual([
      "UNKNOWN",
      "UNKNOWN",
      "UNKNOWN",
      "UNKNOWN",
    ])
  })
})
