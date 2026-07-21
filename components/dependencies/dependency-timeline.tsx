import {
  TimelineBar,
  type TimelineBucket,
} from "@/components/monitors/timeline-bar"
import type { DependencyState } from "@/lib/dependencies/types"

/** One bucket of dependency state history, as returned by lib/dependencies/queries.ts buildStateBuckets. `state` is null before the dependency existed. */
export interface DependencyStateBucket {
  start: string
  state: DependencyState | null
}

// Decision 5, Docs/Specs/DEPENDENCY-MONITORING.md "Implementation plan": maps the
// five-state dependency model onto TimelineBar's existing bucket states.
// MAINTENANCE reuses the striped paused treatment, UNKNOWN and "no interval
// yet" both reuse no-data since neither is evidence of a provider outage.
const bucketStateFor: Record<DependencyState, TimelineBucket["state"]> = {
  OPERATIONAL: "up",
  DEGRADED: "verifying",
  OUTAGE: "down",
  MAINTENANCE: "paused",
  UNKNOWN: "no-data",
}

/** Pure mapping from dependency state buckets to TimelineBar buckets. Exported for tests. `bucketMs` is the fixed width of each bucket (3_600_000 for 24h, 86_400_000 for 7d), used only to label each bucket's covered range. */
export function mapDependencyBucketsToTimeline(
  buckets: readonly DependencyStateBucket[],
  bucketMs: number
): TimelineBucket[] {
  return buckets.map((bucket) => {
    const start = new Date(bucket.start)
    const end = new Date(start.getTime() + bucketMs)
    return {
      state: bucket.state ? bucketStateFor[bucket.state] : "no-data",
      label: `${start.toISOString()}–${end.toISOString()}`,
      checks: bucket.state ? 1 : 0,
      failures: bucket.state === "OUTAGE" ? 1 : 0,
    }
  })
}

export function DependencyTimeline({
  buckets,
  bucketMs,
  label,
  height = 24,
  className,
  timeZone,
}: {
  buckets: readonly DependencyStateBucket[]
  bucketMs: number
  label: string
  height?: 24 | 32
  className?: string
  timeZone?: string
}) {
  return (
    <TimelineBar
      buckets={mapDependencyBucketsToTimeline(buckets, bucketMs)}
      className={className}
      height={height}
      label={label}
      timeZone={timeZone}
    />
  )
}
