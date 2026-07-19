import { and, eq, isNull, sql as dsql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { checkResults, incidents, metricRollups, monitorRegistry, monitorState } from "@/lib/db/schema";

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

export async function listDashboardMonitors() {
  // uptime24h blends 15m metric_rollups with raw check_results because rollups close
  // at quarter-hour boundaries and lag up to 15 minutes on their own. check_results
  // rows are purged 30 days after creation independently of rollup status
  // (retention in lib/maintenance, compaction reads check_batches in
  // lib/storage), so a raw row and its rollup bucket coexist. The raw side
  // is an anti-join: only raw checks whose own 15m bucket lacks a rollup
  // row are counted, so gaps are covered by raw data, never double-counted.
  // A gap whose raw rows were already purged cannot be recovered here.
  // Both sides are clamped to [start15m, end15m), the most recent completed
  // 24h of quarter-hour buckets, so the card always covers exactly 24 hours
  // and agrees with the detail page's completed rollup window. Checks in the
  // current partial bucket are excluded until their bucket closes.
  // The window filter and bucket comparison below use check_results.scheduled_at
  // (not checked_at): metric_rollups buckets are date_bin'd from check_batches
  // .scheduled_minute (see COMPACT_15_MINUTE_SQL), and check_results.scheduled_at
  // is set from that same scheduled minute (lib/scheduler/coordinator.ts). A
  // check scheduled just before a 15m boundary but completing after it must be
  // compared on scheduled_at, or it would land in the rollup's earlier bucket
  // while the anti-join probed the later checked_at bucket, double-counting it.
  const end15m = new Date();
  end15m.setUTCMinutes(Math.floor(end15m.getUTCMinutes() / 15) * 15, 0, 0);
  const start15m = new Date(end15m.getTime() - 86_400_000);
  // Raw sql template params must be bound as ISO strings, never Date objects.
  // Params in dsql templates bypass drizzle's column mappers, and postgres-js
  // rejects a raw Date at the wire layer. The server infers timestamptz from
  // the comparison context.
  const rows = await db
    .select({
      id: monitorRegistry.id,
      name: monitorRegistry.name,
      url: monitorRegistry.url,
      state: monitorState.state,
      lastLatencyMs: monitorState.lastLatencyMs,
      lastCheckedAt: monitorState.lastCheckedAt,
      activeIncidentOpenedAt: incidents.openedAt,
      uptime24h: dsql<number | null>`(
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
        ) rollup
        cross join lateral (
          select count(*) as completed,
            count(*) filter (where ${checkResults.successful}) as successful
          from ${checkResults}
          where ${checkResults.monitorId} = ${monitorRegistry.id}
            and ${checkResults.scheduledAt} >= ${start15m.toISOString()}
            and ${checkResults.scheduledAt} < ${end15m.toISOString()}
            and not exists (
              select 1 from ${metricRollups} covered
              where covered.monitor_id = ${monitorRegistry.id}
                and covered.resolution = '15m'
                and covered.bucket_start = date_bin('15 minutes', ${checkResults.scheduledAt}, timestamptz '2000-01-01')
            )
        ) raw
      )`,
    })
    .from(monitorRegistry)
    .leftJoin(monitorState, eq(monitorState.monitorId, monitorRegistry.id))
    .leftJoin(
      incidents,
      and(eq(incidents.monitorId, monitorRegistry.id), isNull(incidents.resolvedAt)),
    )
    .where(isNull(monitorRegistry.archivedAt));

  return rows
    .flatMap((row) => {
      if (row.state === "ARCHIVED") return [];
      return [{
        ...row,
        state: row.state ?? ("PENDING" as const),
        lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
        activeIncidentOpenedAt: row.activeIncidentOpenedAt?.toISOString() ?? null,
        uptime24h: row.uptime24h === null ? null : Number(row.uptime24h),
      }];
    })
    .sort((left, right) => {
      const state = stateOrder.indexOf(left.state) - stateOrder.indexOf(right.state);
      return state || left.name.localeCompare(right.name);
    });
}
