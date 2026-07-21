import type { DependencyState } from "./types"

// Pure render-time bucketing for dependency timelines. Kept free of db and
// server-only imports so the bucket math, including the assumed-operational
// backfill overlay, is unit-testable on its own.

const SEVEN_DAYS_MS = 7 * 86_400_000

// Lower number is worse. worst_of picks the minimum priority across every
// state overlapping a bucket, matching the poll path's severity ordering.
const STATE_PRIORITY: Record<DependencyState, number> = {
  OUTAGE: 0,
  DEGRADED: 1,
  MAINTENANCE: 2,
  UNKNOWN: 3,
  OPERATIONAL: 4,
}

// Folds one candidate state into the running worst, treating null as "nothing
// seen yet". A candidate only wins when it is strictly worse.
function worseState(
  current: DependencyState | null,
  candidate: DependencyState
): DependencyState {
  if (current === null || STATE_PRIORITY[candidate] < STATE_PRIORITY[current]) {
    return candidate
  }
  return current
}

/**
 * Maps a stored provider incident's free-form impact string onto the severity
 * a matched incident contributes to an assumed-operational backfill bucket.
 * This is a render-time floor, not a precise per-component state, since the
 * impact vocabulary varies by provider (statuspage and auth0 publish
 * critical/major/minor/none/maintenance, google stores a severity string,
 * others store null). It mirrors auth0's incidentComponentState: critical and
 * major read as OUTAGE, a maintenance impact reads as MAINTENANCE, and every
 * other or unrecognized value reads as DEGRADED, so a matched incident never
 * renders green.
 */
export function incidentImpactState(impact: string | null): DependencyState {
  const normalized = impact?.toLowerCase() ?? null
  if (normalized === "critical" || normalized === "major") {
    return "OUTAGE"
  }
  if (normalized === "maintenance") {
    return "MAINTENANCE"
  }
  return "DEGRADED"
}

export interface IntervalRow {
  state: string
  startedAt: Date
  endedAt: Date | null
}

export interface StateBucket {
  start: string
  state: DependencyState | null
}

/** A matched provider incident, with its impact already resolved to the state it contributes to overlapping backfill buckets. */
export interface BackfillIncident {
  startedAt: Date
  resolvedAt: Date | null
  state: DependencyState
}

/**
 * Assumed-operational backfill for a newly installed dependency. Buckets
 * between `createdAt - 7d` and `createdAt` carry no state interval, since the
 * database never fabricates uptime rows for time before the install existed.
 * At render time those buckets are assumed OPERATIONAL, raised to a matched
 * incident's state where the incident's active window overlaps them. Buckets
 * entirely before `createdAt - 7d` stay null (grey, "no data"), and buckets
 * at or after `createdAt` are left to the real state intervals.
 */
export interface BackfillWindow {
  createdAt: Date
  incidents: readonly BackfillIncident[]
}

/**
 * Buckets a dependency's state-interval history into fixed-width windows,
 * picking the worst overlapping state per bucket. A bucket with no overlapping
 * interval is null (before the dependency existed) unless the optional
 * `backfill` puts it inside the assumed-operational window, where it resolves
 * to the worst of OPERATIONAL and any overlapping matched incident. `end` is
 * the right edge of the most recent bucket.
 */
export function buildStateBuckets(
  intervals: readonly IntervalRow[],
  bucketCount: number,
  bucketMs: number,
  end: Date,
  backfill?: BackfillWindow
): StateBucket[] {
  const endMs = end.getTime()
  const windowStart = endMs - bucketCount * bucketMs
  const createdAtMs = backfill ? backfill.createdAt.getTime() : null
  const assumedStartMs =
    createdAtMs === null ? null : createdAtMs - SEVEN_DAYS_MS
  const buckets: StateBucket[] = []
  for (let index = 0; index < bucketCount; index += 1) {
    const bucketStart = windowStart + index * bucketMs
    const bucketEnd = bucketStart + bucketMs
    let worst: DependencyState | null = null
    for (const interval of intervals) {
      const intervalEnd = interval.endedAt ? interval.endedAt.getTime() : endMs
      if (
        interval.startedAt.getTime() < bucketEnd &&
        intervalEnd > bucketStart
      ) {
        worst = worseState(worst, interval.state as DependencyState)
      }
    }
    // Assume operational for any bucket that overlaps the trailing 7 days
    // before the install, then raise it where a matched incident overlaps.
    // Buckets fully before that window keep whatever the intervals gave them
    // (typically null), so pre-install-minus-7d time stays grey.
    if (
      backfill &&
      createdAtMs !== null &&
      assumedStartMs !== null &&
      bucketStart < createdAtMs &&
      bucketEnd > assumedStartMs
    ) {
      worst = worseState(worst, "OPERATIONAL")
      for (const incident of backfill.incidents) {
        const incidentEnd = incident.resolvedAt
          ? incident.resolvedAt.getTime()
          : endMs
        if (
          incident.startedAt.getTime() < bucketEnd &&
          incidentEnd > bucketStart
        ) {
          worst = worseState(worst, incident.state)
        }
      }
    }
    buckets.push({ start: new Date(bucketStart).toISOString(), state: worst })
  }
  return buckets
}
