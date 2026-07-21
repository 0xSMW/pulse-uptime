import { sql } from "@/lib/db/client"
import { portableQueryValues } from "@/lib/db/query-values"

import type { RawBucketAvailability } from "./timeline"

// Scheduler-derived raw availability: 15m buckets decoded from check_batches
// bitmaps. expected/completed/failure bits are the source of coverage, so a
// scheduler gap is unknown rather than perfect coverage. Compacted 15m rollups
// (COMPACT_15_MINUTE_SQL) use the same bit rules, so raw-to-rollup has no
// discontinuity when a bucket closes.
//
// Time-range predicate runs on check_batches before unnest, so a bounded
// window never expands every retained minute row. monitor_ids are unnested with
// ordinality and the bit at that ordinal is read from each bitmap.
//
// Per expected minute slot:
//   expected   = expected bit set
//   completed  = expected and completed
//   failed     = expected and completed and failure
//   successful = completed minus failed
//   unknown    = expected minus completed
//
// Headline uptime uses successful/completed only. unknown is a separate
// coverage dimension and is never treated as a failure.

export const RAW_AVAILABILITY_BUCKETS_SQL = `
with ranged as (
  select scheduled_minute, monitor_ids, expected_bitmap, completed_bitmap, failure_bitmap
  from check_batches
  where scheduled_minute >= $1::timestamptz
    and scheduled_minute < $2::timestamptz
), slots as (
  select
    date_bin(interval '15 minutes', ranged.scheduled_minute, timestamptz '2000-01-01') bucket_start,
    ids.monitor_id,
    ((get_byte(ranged.expected_bitmap, ((ids.position - 1) / 8)::integer)
      >> (((ids.position - 1) % 8)::integer)) & 1) expected,
    ((get_byte(ranged.completed_bitmap, ((ids.position - 1) / 8)::integer)
      >> (((ids.position - 1) % 8)::integer)) & 1) completed,
    ((get_byte(ranged.failure_bitmap, ((ids.position - 1) / 8)::integer)
      >> (((ids.position - 1) % 8)::integer)) & 1) failed
  from ranged
  cross join lateral unnest(ranged.monitor_ids) with ordinality as ids(monitor_id, position)
  where ids.monitor_id = any($3::text[])
)
select
  slots.monitor_id,
  slots.bucket_start,
  count(*) filter (where slots.expected = 1)::integer expected_checks,
  count(*) filter (where slots.expected = 1 and slots.completed = 1)::integer completed_checks,
  count(*) filter (
    where slots.expected = 1 and slots.completed = 1 and slots.failed = 0
  )::integer successful_checks,
  count(*) filter (
    where slots.expected = 1 and slots.completed = 1 and slots.failed = 1
  )::integer failed_checks,
  count(*) filter (where slots.expected = 1 and slots.completed = 0)::integer unknown_checks
from slots
where slots.expected = 1
group by slots.monitor_id, slots.bucket_start
order by slots.monitor_id, slots.bucket_start
`

export interface RawAvailabilityBucketDbRow {
  monitor_id: string
  bucket_start: Date | string
  expected_checks: number | string
  completed_checks: number | string
  successful_checks: number | string
  failed_checks: number | string
  unknown_checks: number | string
}

export type RawAvailabilityBucket = RawBucketAvailability & {
  monitorId: string
}

function toDate(value: Date | string): Date {
  return Object.prototype.toString.call(value) === "[object Date]"
    ? (value as Date)
    : new Date(value)
}

export function mapRawAvailabilityRow(
  row: RawAvailabilityBucketDbRow
): RawAvailabilityBucket {
  return {
    monitorId: row.monitor_id,
    bucketStart: toDate(row.bucket_start),
    expectedChecks: Number(row.expected_checks) || 0,
    completedChecks: Number(row.completed_checks) || 0,
    successfulChecks: Number(row.successful_checks) || 0,
    failedChecks: Number(row.failed_checks) || 0,
    unknownChecks: Number(row.unknown_checks) || 0,
    // Incidents are not joined on the raw side. Downtime lands once the
    // quarter-hour compacts into a rollup.
    downtimeSeconds: 0,
  }
}

// One bounded check_batches scan for every requested monitor. Empty ids skip
// the round trip. A decode or query failure degrades to an empty list so the
// timeline falls back to rollups alone.
export async function fetchRawAvailabilityBuckets(
  monitorIds: readonly string[],
  start: Date,
  end: Date
): Promise<RawAvailabilityBucket[]> {
  if (monitorIds.length === 0) {
    return []
  }
  if (start.getTime() >= end.getTime()) {
    return []
  }
  try {
    const rows = (await sql.unsafe(
      RAW_AVAILABILITY_BUCKETS_SQL,
      portableQueryValues([start, end, [...monitorIds]]) as never[]
    )) as unknown as RawAvailabilityBucketDbRow[]
    return rows.map(mapRawAvailabilityRow)
  } catch {
    return []
  }
}

export async function fetchRawAvailabilityBucketsForMonitor(
  monitorId: string,
  start: Date,
  end: Date
): Promise<RawBucketAvailability[]> {
  const rows = await fetchRawAvailabilityBuckets([monitorId], start, end)
  return rows.map(({ monitorId: _id, ...bucket }) => {
    void _id
    return bucket
  })
}
