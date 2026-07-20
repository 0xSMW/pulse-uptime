import { and, eq, gte, inArray, isNull, lt, sql as dsql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { checkResults, incidents, metricRollups, monitorRegistry, monitorState } from "@/lib/db/schema";
import { isRangeUnlocked, rollupsSinceActivation } from "@/lib/reporting/queries/first-run";
import { blendRawAvailability, buildRollupTimeline, type RawBucketAvailability } from "@/lib/reporting/queries/timeline";

const stateOrder = [
  "DOWN",
  "VERIFYING_DOWN",
  "VERIFYING_UP",
  "PENDING",
  "UP",
  "PAUSED",
  "ARCHIVED",
] as const;

export async function listCommandPaletteMonitors() {
  const rows = await db.select({
    id: monitorRegistry.id,
    name: monitorRegistry.name,
    state: monitorState.state,
    lastLatencyMs: monitorState.lastLatencyMs,
  }).from(monitorRegistry)
    .leftJoin(monitorState, eq(monitorState.monitorId, monitorRegistry.id))
    .where(isNull(monitorRegistry.archivedAt));

  return rows.flatMap((monitor) => {
    const state = monitor.state ?? ("PENDING" as const);
    return state === "ARCHIVED" ? [] : [{ ...monitor, state }];
  }).sort((left, right) => {
    const state = stateOrder.indexOf(left.state) - stateOrder.indexOf(right.state);
    return state || left.name.localeCompare(right.name);
  });
}

// The most recent completed window of quarter-hour buckets. Checks in the
// current partial bucket are excluded until their bucket closes, so every
// reader covers exactly 24 hours and agrees with the detail page's completed
// rollup window.
function completed24hWindow() {
  const end15m = new Date();
  end15m.setUTCMinutes(Math.floor(end15m.getUTCMinutes() / 15) * 15, 0, 0);
  return { start15m: new Date(end15m.getTime() - 86_400_000), end15m };
}

// uptime24h blends 15m metric_rollups with raw check_results because rollups close
// at quarter-hour boundaries and lag up to 15 minutes on their own. check_results
// rows are purged 30 days after creation independently of rollup status
// (retention in lib/maintenance, compaction reads check_batches in
// lib/storage), so a raw row and its rollup bucket coexist. The raw side
// is an anti-join: only raw checks whose own 15m bucket lacks a rollup
// row are counted, so gaps are covered by raw data, never double-counted.
// A gap whose raw rows were already purged cannot be recovered here.
// Both sides are clamped to [start15m, end15m).
// The window filter and bucket comparison below use check_results.scheduled_at
// (not checked_at): metric_rollups buckets are date_bin'd from check_batches
// .scheduled_minute (see COMPACT_15_MINUTE_SQL), and check_results.scheduled_at
// is set from that same scheduled minute (lib/scheduler/coordinator.ts). A
// check scheduled just before a 15m boundary but completing after it must be
// compared on scheduled_at, or it would land in the rollup's earlier bucket
// while the anti-join probed the later checked_at bucket, double-counting it.
// Both sides also drop everything before monitor_state.activated_at, matching
// rollupsSinceActivation which keeps only buckets whose start is at or after
// activation, so setup-phase failures never reach the value and it agrees with
// the detail page. A never-activated monitor has a null activated_at, so every
// comparison is null and the value reads null, the collecting placeholder.
// The expression must be selected from monitorRegistry left joined to
// monitorState, it references both tables' columns.
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
          select count(*) as completed,
            count(*) filter (where ${checkResults.successful}) as successful
          from ${checkResults}
          where ${checkResults.monitorId} = ${monitorRegistry.id}
            and ${checkResults.scheduledAt} >= ${start15m.toISOString()}
            and ${checkResults.scheduledAt} < ${end15m.toISOString()}
            and date_bin('15 minutes', ${checkResults.scheduledAt}, timestamptz '2000-01-01') >= ${monitorState.activatedAt}
            and not exists (
              select 1 from ${metricRollups} covered
              where covered.monitor_id = ${monitorRegistry.id}
                and covered.resolution = '15m'
                and covered.bucket_start = date_bin('15 minutes', ${checkResults.scheduledAt}, timestamptz '2000-01-01')
            )
        ) raw
      )`;
}

// Locked windows read null so a monitor still collecting its first full day
// reports no uptime rather than a partial figure, the same gate the
// dashboard's collecting placeholder uses.
export async function uptime24hByMonitorId(ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, number | null>();
  const { start15m, end15m } = completed24hWindow();
  const rows = await db
    .select({
      id: monitorRegistry.id,
      activatedAt: monitorState.activatedAt,
      uptime24h: uptime24hSql(start15m, end15m),
    })
    .from(monitorRegistry)
    .leftJoin(monitorState, eq(monitorState.monitorId, monitorRegistry.id))
    .where(inArray(monitorRegistry.id, [...ids]));
  return new Map<string, number | null>(rows.map((row) => [
    row.id,
    row.uptime24h !== null && isRangeUnlocked("h24", row.activatedAt, end15m) ? Number(row.uptime24h) : null,
  ]));
}

export async function listDashboardMonitors() {
  const { start15m, end15m } = completed24hWindow();
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
      and(eq(incidents.monitorId, monitorRegistry.id), isNull(incidents.resolvedAt)),
    )
    .where(isNull(monitorRegistry.archivedAt));

  // One grouped fetch feeds every row's timeline. The bar blends the same two
  // sources the uptime figure does: 15m rollups, plus raw check_results for any
  // quarter-hour a rollup has not closed yet. During compaction lag the newest
  // cells read up or down from raw rather than no-data, so the bar can never
  // show no-data for a bucket the figure already counts as covered. A bucket
  // with neither a rollup nor a surviving raw row stays no-data.
  const monitorIds = rows.map((row) => row.id);
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
      .where(and(
        inArray(metricRollups.monitorId, monitorIds),
        eq(metricRollups.resolution, "15m"),
        gte(metricRollups.bucketStart, start15m),
        lt(metricRollups.bucketStart, end15m),
      ))
      .orderBy(metricRollups.bucketStart)
    : [];
  const rollupsByMonitor = new Map<string, typeof timelineRollups>();
  for (const rollup of timelineRollups) {
    const list = rollupsByMonitor.get(rollup.monitorId);
    if (list) list.push(rollup);
    else rollupsByMonitor.set(rollup.monitorId, [rollup]);
  }

  // One grouped raw scan for the same window and the same monitors, the timeline
  // twin of the uptime figure's raw side. It reads the (monitor_id, scheduled_at)
  // unique index over a bounded 24h range and groups into 15m buckets, so it
  // stays one query no heavier than the rollup fetch above. The anti-join that
  // keeps a bucket from being counted twice runs in blendRawAvailability below,
  // against the rollup buckets already in hand, so this fetch needs no rollup
  // join of its own. scheduled_at (not checked_at) matches the rollup bucketing
  // in COMPACT_15_MINUTE_SQL, the same column the uptime anti-join compares on.
  const rawBucketStart = dsql<Date>`date_bin('15 minutes', ${checkResults.scheduledAt}, timestamptz '2000-01-01')`;
  const timelineRawBuckets = rows.length
    ? await db
      .select({
        monitorId: checkResults.monitorId,
        bucketStart: rawBucketStart,
        completedChecks: dsql<number>`count(*)::int`,
        successfulChecks: dsql<number>`count(*) filter (where ${checkResults.successful})::int`,
        failedChecks: dsql<number>`count(*) filter (where not ${checkResults.successful})::int`,
      })
      .from(checkResults)
      .where(and(
        inArray(checkResults.monitorId, monitorIds),
        gte(checkResults.scheduledAt, start15m),
        lt(checkResults.scheduledAt, end15m),
      ))
      .groupBy(checkResults.monitorId, rawBucketStart)
    : [];
  const rawByMonitor = new Map<string, RawBucketAvailability[]>();
  for (const raw of timelineRawBuckets) {
    const completed = Number(raw.completedChecks);
    const bucket: RawBucketAvailability = {
      bucketStart: new Date(raw.bucketStart),
      expectedChecks: completed,
      completedChecks: completed,
      successfulChecks: Number(raw.successfulChecks),
      failedChecks: Number(raw.failedChecks),
      unknownChecks: 0,
      downtimeSeconds: 0,
    };
    const list = rawByMonitor.get(raw.monitorId);
    if (list) list.push(bucket);
    else rawByMonitor.set(raw.monitorId, [bucket]);
  }

  return rows
    .flatMap((row) => {
      if (row.state === "ARCHIVED") return [];
      return [{
        ...row,
        state: row.state ?? ("PENDING" as const),
        lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
        activatedAt: row.activatedAt?.toISOString() ?? null,
        activeIncidentOpenedAt: row.activeIncidentOpenedAt?.toISOString() ?? null,
        // 32 buckets of 45 minutes each, the table's compact cousin of the
        // detail page's 60-bucket availability bar over the same window. Raw
        // checks fill any quarter-hour a rollup has not closed, then the
        // activation filter drops pre-activation buckets from both sources.
        timeline: buildRollupTimeline(
          rollupsSinceActivation(
            blendRawAvailability(rollupsByMonitor.get(row.id) ?? [], rawByMonitor.get(row.id) ?? []),
            row.activatedAt,
          ),
          32, 86_400_000, end15m,
        ),
        // The card claims a full 24 hours, so it unlocks only once the completed
        // window reaches a whole day back to activation, the same gate the detail
        // page uses. A monitor active by wall clock but activated inside the
        // window still reads as collecting until its window fills.
        uptime24hUnlocked: isRangeUnlocked("h24", row.activatedAt, end15m),
        uptime24h: row.uptime24h === null ? null : Number(row.uptime24h),
      }];
    })
    .sort((left, right) => {
      const state = stateOrder.indexOf(left.state) - stateOrder.indexOf(right.state);
      return state || left.name.localeCompare(right.name);
    });
}
