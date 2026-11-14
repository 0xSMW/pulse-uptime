import { createHash } from "node:crypto"

import type { ExclusionSlot } from "@/lib/incidents/exclusions"

export interface ExcludedCounts {
  excludedChecks?: number
  excludedDowntimeSeconds?: number
}

const WIDTHS = { "15m": 900_000, hour: 3_600_000, day: 86_400_000 }

// The observed counts stay intact so coverage and the original result remain
// available. Corrections only attach to buckets that actually contain data.
export function overlayExclusions<T extends { bucketStart: Date }>(
  rows: T[],
  slots: readonly ExclusionSlot[],
  resolution: keyof typeof WIDTHS,
  monitorId?: string,
  options: { raw?: boolean } = {}
): Array<T & ExcludedCounts> {
  const corrections = new Map<number, { checks: number; downtime: number }>()
  const seen = new Set<string>()
  const width = WIDTHS[resolution]
  for (const slot of slots) {
    if (monitorId !== undefined && slot.monitorId !== monitorId) {
      continue
    }
    const identity = `${slot.monitorId}:${slot.scheduledMinute.getTime()}`
    if (seen.has(identity)) {
      continue
    }
    seen.add(identity)
    const bucket = Math.floor(slot.scheduledMinute.getTime() / width) * width
    const correction = corrections.get(bucket) ?? { checks: 0, downtime: 0 }
    correction.checks += Number(slot.failed)
    correction.downtime += slot.downtimeSeconds
    corrections.set(bucket, correction)
  }
  return rows.map((row) => {
    const correction = corrections.get(row.bucketStart.getTime())
    return {
      ...row,
      excludedChecks: correction?.checks ?? 0,
      excludedDowntimeSeconds: options.raw ? 0 : (correction?.downtime ?? 0),
    }
  })
}

export function exclusionVersion(slots: readonly ExclusionSlot[]): string {
  const values = slots
    .map(
      (slot) =>
        `${slot.monitorId}:${slot.scheduledMinute.toISOString()}:${Number(slot.failed)}:${slot.downtimeSeconds}`
    )
    .sort()
  return createHash("sha256").update(values.join("|")).digest("hex")
}
