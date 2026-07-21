import { and, sql as dsql, eq, gte, inArray, isNull, lt } from "drizzle-orm"

import { db } from "@/lib/db/client"
import {
  incidents,
  metricRollups,
  monitorRegistry,
  monitorState,
} from "@/lib/db/schema"
import {
  isRangeUnlocked,
  rollupsSinceActivation,
} from "@/lib/reporting/queries/first-run"
import { fetchRawAvailabilityBuckets } from "@/lib/reporting/queries/raw-availability"
import {
  blendRawAvailability,
  buildRollupTimeline,
  type RawBucketAvailability,
} from "@/lib/reporting/queries/timeline"

const stateOrder = [
  "DOWN",
  "VERIFYING_DOWN",
  "VERIFYING_UP",
  "PENDING",
  "UP",
  "PAUSED",
  "ARCHIVED",
] as const

export async function listCommandPaletteMonitors() {
  const rows = await db
    .select({
      id: monitorRegistry.id,
      name: monitorRegistry.name,
      state: monitorState.state,
      lastLatencyMs: monitorState.lastLatencyMs,
    })
    .from(monitorRegistry)
    .leftJoin(monitorState, eq(monitorState.monitorId, monitorRegistry.id))
    .where(isNull(monitorRegistry.archivedAt))

  return rows
    .flatMap((monitor) => {
      const state = monitor.state ?? ("PENDING" as const)
      return state === "ARCHIVED" ? [] : [{ ...monitor, state }]
    })
    .sort((left, right) => {
      const state =
        stateOrder.indexOf(left.state) - stateOrder.indexOf(right.state)
      return state || left.name.localeCompare(right.name)
    })
}

// The most recent completed window of quarter-hour buckets. Checks in the
// current partial bucket are excluded until their bucket closes, so every
// reader covers exactly 24 hours and agrees with the detail page's completed
// rollup window.
function completed24hWindow() {
  const end15m = new Date()
  end15m.setUTCMinutes(Math.floor(end15m.getUTCMinutes() / 15) * 15, 0, 0)
  return { start15m: new Date(end15m.getTime() - 86_400_000), end15m }
}

// uptime24h blends 15m metric_rollups with scheduler-derived raw slots from
// check_batches because rollups close at quarter-hour boundaries and lag up to
// 15 minutes on their own. The raw side is an anti-join: only expected minute
// slots whose own 15m bucket lacks a rollup row are counted, so gaps are covered
// by raw data, never double-counted. A gap whose check_batches row was already
// purged cannot be recovered here. Both sides are clamped to [start15m, end15m).
//
// Buckets are date_bin'd from check_batches.scheduled_minute, the same column
// COMPACT_15_MINUTE_SQL uses, so a raw quarter-hour lands in the rollup bucket
// it would compact into. Uptime is successful/completed only: unknown
// (expected minus completed) is a separate coverage dimension and never enters
// the ratio as a failure. Both sides also drop everything before
// monitor_state.activated_at, matching rollupsSinceActivation, so setup-phase
// failures never reach the value and it agrees with the detail page. A
// never-activated monitor has a null activated_at, so every comparison is null
// and the value reads null, the collecting placeholder. The expression must be
// selected from monitorRegistry left joined to monitorState, it references both
// tables' columns.
function uptime24hSql(start15m: Date, end15m: Date) {
  // Raw sql template params must be bound as ISO strings, never Date objects.
  // Params in dsql templates bypass drizzle's column mappers, and postgres-js
  // rejects a raw Date at the wire layer. The server infers timestamptz from
  // the comparison context.
  return dsql<number | null>`(
        select case when coalesce(rollup.completed, 0) + coalesce(raw.completed, 0) = 0 then null
          else 100.0 * (coalesce(rollup.successful, 0) + coalesce(raw.successful, 0))
            / (coalesce(rollup.completed, 0) + coalesce(raw.completed, 0)) end
        from (
          select sum(${metricRollups.completedChecks}) as completed,
            sum(${metricRollups.successfulChecks}) as successful
          from ${metricRollups}
          where ${metricRollups.monitorId} = ${monitorRegistry.id}
            and ${metricRollups.resolution} = '15m'
            and ${metricRollups.bucketStart} >= ${start15m.toISOString()}
            and ${metricRollups.bucketStart} < ${end15m.toISOString()}
            and ${metricRollups.bucketStart} >= ${monitorState.activatedAt}
        ) rollup
        cross join lateral (
          select
            count(*) filter (where bit.expected = 1 and bit.completed = 1) as completed,
            count(*) filter (
              where bit.expected = 1 and bit.completed = 1 and bit.failed = 0
            ) as successful
          from (
            select
              date_bin(
                interval '15 minutes', ranged.scheduled_minute, timestamptz '2000-01-01'
              ) as bucket_start,
              ((get_byte(ranged.expected_bitmap, ((ids.position - 1) / 8)::integer)
                >> (((ids.position - 1) % 8)::integer)) & 1) as expected,
              ((get_byte(ranged.completed_bitmap, ((ids.position - 1) / 8)::integer)
                >> (((ids.position - 1) % 8)::integer)) & 1) as completed,
              ((get_byte(ranged.failure_bitmap, ((ids.position - 1) / 8)::integer)
                >> (((ids.position - 1) % 8)::integer)) & 1) as failed
            from (
              select scheduled_minute, monitor_ids, expected_bitmap, completed_bitmap, failure_bitmap
              from check_batches
              where scheduled_minute >= ${start15m.toISOString()}
                and scheduled_minute < ${end15m.toISOString()}
            ) ranged
            cross join lateral unnest(ranged.monitor_ids) with ordinality as ids(monitor_id, position)
            where ids.monitor_id = ${monitorRegistry.id}
          ) bit
          where bit.expected = 1
            and bit.bucket_start >= ${monitorState.activatedAt}
            and not exists (
              select 1 from ${metricRollups} covered
              where covered.monitor_id = ${monitorRegistry.id}
                and covered.resolution = '15m'
                and covered.bucket_start = bit.bucket_start
            )
        ) raw
      )`
}

// Locked windows read null so a monitor still collecting its first full day
// reports no uptime rather than a partial figure, the same gate the
// dashboard's collecting placeholder uses.
export async function uptime24hByMonitorId(ids: readonly string[]) {
  if (ids.length === 0) {
    return new Map<string, number | null>()
  }
  const { start15m, end15m } = completed24hWindow()
  const rows = await db
    .select({
      id: monitorRegistry.id,
      activatedAt: monitorState.activatedAt,
      uptime24h: uptime24hSql(start15m, end15m),
    })
    .from(monitorRegistry)
    .leftJoin(monitorState, eq(monitorState.monitorId, monitorRegistry.id))
    .where(inArray(monitorRegistry.id, [...ids]))
  return new Map<string, number | null>(
    rows.map((row) => [
      row.id,
      row.uptime24h !== null && isRangeUnlocked("h24", row.activatedAt, end15m)
        ? Number(row.uptime24h)
        : null,
    ])
  )
}

export async function listDashboardMonitors() {
  const { start15m, end15m } = completed24hWindow()
  const rows = await db
    .select({
      id: monitorRegistry.id,
      name: monitorRegistry.name,
      url: monitorRegistry.url,
      state: monitorState.state,
      latestLatencyMs: monitorState.lastLatencyMs,
      lastCheckedAt: monitorState.lastCheckedAt,
      activatedAt: monitorState.activatedAt,
      activeIncidentOpenedAt: incidents.openedAt,
      uptime24h: uptime24hSql(start15m, end15m),
    })
    .from(monitorRegistry)
    .leftJoin(monitorState, eq(monitorState.monitorId, monitorRegistry.id))
    .leftJoin(
      incidents,
      and(
        eq(incidents.monitorId, monitorRegistry.id),
        isNull(incidents.resolvedAt)
      )
    )
    .where(isNull(monitorRegistry.archivedAt))

  // One grouped fetch feeds every row's timeline. The bar blends the same two
  // sources the uptime figure does: 15m rollups, plus scheduler-derived raw
  // buckets for any quarter-hour a rollup has not closed yet. During compaction
  // lag the newest cells read up, down, or verifying from raw rather than
  // no-data, so the bar can never show no-data for a bucket the figure already
  // counts as covered. A bucket with neither a rollup nor a surviving raw row
  // stays no-data.
  const monitorIds = rows.map((row) => row.id)
  const timelineRollups = rows.length
    ? await db
        .select({
          monitorId: metricRollups.monitorId,
          bucketStart: metricRollups.bucketStart,
          expectedChecks: metricRollups.expectedChecks,
          completedChecks: metricRollups.completedChecks,
          successfulChecks: metricRollups.successfulChecks,
          failedChecks: metricRollups.failedChecks,
          unknownChecks: metricRollups.unknownChecks,
          downtimeSeconds: metricRollups.downtimeSeconds,
        })
        .from(metricRollups)
        .where(
          and(
            inArray(metricRollups.monitorId, monitorIds),
            eq(metricRollups.resolution, "15m"),
            gte(metricRollups.bucketStart, start15m),
            lt(metricRollups.bucketStart, end15m)
          )
        )
        .orderBy(metricRollups.bucketStart)
    : []
  const rollupsByMonitor = new Map<string, typeof timelineRollups>()
  for (const rollup of timelineRollups) {
    const list = rollupsByMonitor.get(rollup.monitorId)
    if (list) {
      list.push(rollup)
    } else {
      rollupsByMonitor.set(rollup.monitorId, [rollup])
    }
  }

  // One grouped raw scan for the same window and the same monitors, the timeline
  // twin of the uptime figure's raw side. It decodes check_batches bitmaps over
  // a bounded 24h range and groups into 15m buckets with the same expected/
  // completed/failure rules as compaction, so scheduler gaps surface as unknown
  // rather than perfect coverage. The anti-join that keeps a bucket from being
  // counted twice runs in blendRawAvailability below, against the rollup buckets
  // already in hand, so this fetch needs no rollup join of its own.
  const timelineRawBuckets = rows.length
    ? await fetchRawAvailabilityBuckets(monitorIds, start15m, end15m)
    : []
  const rawByMonitor = new Map<string, RawBucketAvailability[]>()
  for (const raw of timelineRawBuckets) {
    const { monitorId, ...bucket } = raw
    const list = rawByMonitor.get(monitorId)
    if (list) {
      list.push(bucket)
    } else {
      rawByMonitor.set(monitorId, [bucket])
    }
  }

  return rows
    .flatMap((row) => {
      if (row.state === "ARCHIVED") {
        return []
      }
      return [
        {
          ...row,
          state: row.state ?? ("PENDING" as const),
          lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
          activatedAt: row.activatedAt?.toISOString() ?? null,
          activeIncidentOpenedAt:
            row.activeIncidentOpenedAt?.toISOString() ?? null,
          // 32 buckets of 45 minutes each, the table's compact cousin of the
          // detail page's 60-bucket availability bar over the same window. Raw
          // batch buckets fill any quarter-hour a rollup has not closed, then the
          // activation filter drops pre-activation buckets from both sources.
          timeline: buildRollupTimeline(
            rollupsSinceActivation(
              blendRawAvailability(
                rollupsByMonitor.get(row.id) ?? [],
                rawByMonitor.get(row.id) ?? []
              ),
              row.activatedAt
            ),
            32,
            86_400_000,
            end15m
          ),
          // The card claims a full 24 hours, so it unlocks only once the completed
          // window reaches a whole day back to activation, the same gate the detail
          // page uses. A monitor active by wall clock but activated inside the
          // window still reads as collecting until its window fills.
          uptime24hUnlocked: isRangeUnlocked("h24", row.activatedAt, end15m),
          uptime24h: row.uptime24h === null ? null : Number(row.uptime24h),
        },
      ]
    })
    .sort((left, right) => {
      const state =
        stateOrder.indexOf(left.state) - stateOrder.indexOf(right.state)
      return state || left.name.localeCompare(right.name)
    })
}
