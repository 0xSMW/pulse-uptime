"use client"

import * as React from "react"

import { Tooltip, TooltipContent } from "@/components/ui/tooltip"
import type { TimelineBucket } from "@/lib/monitoring/types"
import { formatBucketTimeRange } from "@/lib/reporting/format"
import { cn } from "@/lib/utils"

export type { TimelineBucket }

const bucketClass: Record<TimelineBucket["state"], string> = {
  up: "bg-[var(--up)]",
  down: "bg-[var(--down)]",
  verifying: "bg-[var(--verifying)]",
  paused:
    "bg-[repeating-linear-gradient(135deg,var(--neutral-state)_0,var(--neutral-state)_1px,transparent_1px,transparent_3px)]",
  "no-data": "bg-[var(--chip-bg)]",
}

const stateLabel: Record<TimelineBucket["state"], string> = {
  up: "Operational",
  down: "Down",
  verifying: "Partial",
  paused: "Paused",
  "no-data": "No data",
}

// Two ISO instants embedded in a bucket's legacy label. Read only when a
// bucket predates structured startMs/endMs (the dependency timeline still
// builds label-only buckets), so the tooltip can still show a real range.
const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T[\d:.]+Z/g

function bucketRangeText(bucket: TimelineBucket, timeZone: string): string {
  if (bucket.startMs != null && bucket.endMs != null) {
    return formatBucketTimeRange(bucket.startMs, bucket.endMs, timeZone)
  }
  const matches = bucket.label.match(ISO_INSTANT)
  if (matches && matches.length >= 2) {
    const start = Date.parse(matches[0]!)
    const end = Date.parse(matches[1]!)
    if (!(Number.isNaN(start) || Number.isNaN(end))) {
      return formatBucketTimeRange(start, end, timeZone)
    }
  }
  return bucket.label
}

function bucketCountsText(bucket: TimelineBucket): string {
  const checks = `${bucket.checks} ${bucket.checks === 1 ? "check" : "checks"}`
  return bucket.failures > 0 ? `${checks}, ${bucket.failures} failed` : checks
}

export function TimelineBar({
  buckets,
  height = 24,
  label,
  className,
  timeZone = "UTC",
}: {
  buckets: TimelineBucket[]
  height?: 24 | 32
  label: string
  className?: string
  timeZone?: string
}) {
  const summary = buckets.reduce(
    (result, bucket) => ({
      checks: result.checks + bucket.checks,
      failures: result.failures + bucket.failures,
    }),
    { checks: 0, failures: 0 }
  )

  // A single controlled tooltip serves the whole bar: hovering a cell anchors
  // it to that cell. One popup per bar instead of one per cell keeps a
  // dashboard of many bars, each with dozens of cells, cheap to render.
  const [active, setActive] = React.useState<{
    index: number
    element: HTMLElement
  } | null>(null)
  const activeBucket = active ? buckets[active.index] : undefined

  return (
    <Tooltip
      onOpenChange={(open) => {
        if (!open) {
          setActive(null)
        }
      }}
      open={active !== null}
    >
      <div
        aria-label={`${label}: ${summary.checks} checks, ${summary.failures} failed`}
        className={cn("flex w-full gap-0.5", className)}
        // Clearing on leave scopes the tooltip to the bar container, so it
        // never lingers once the pointer leaves the bar.
        onPointerLeave={() => setActive(null)}
        role="img"
        style={{ height }}
      >
        {/* Spans, not buttons: buckets have no action, and the role="img"
            container already narrates the bar, so focusable cells would only
            add dozens of dead tab stops per bar. The tooltip carries the
            per-bucket detail on hover. */}
        {buckets.map((bucket, index) => (
          <span
            className={cn(
              "min-w-0 flex-1 rounded-[1.5px]",
              bucketClass[bucket.state]
            )}
            key={`${bucket.label}-${index}`}
            onPointerEnter={(event) =>
              setActive({ index, element: event.currentTarget })
            }
          />
        ))}
      </div>
      {active && activeBucket ? (
        <TooltipContent anchor={active.element}>
          <span className="block whitespace-nowrap">
            {bucketRangeText(activeBucket, timeZone)}
          </span>
          <span className="mt-0.5 block whitespace-nowrap text-[var(--fg-muted)]">
            {stateLabel[activeBucket.state]} · {bucketCountsText(activeBucket)}
          </span>
        </TooltipContent>
      ) : null}
    </Tooltip>
  )
}
