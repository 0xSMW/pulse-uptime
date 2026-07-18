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
  // Uptime blends pre-aggregated 15m rollups with raw check_results instead
  // of rescanning 24h of raw checks per monitor. Rollups close at
  // quarter-hour boundaries, so on their own they lag up to 15 minutes.
  // check_results rows are purged 30 days after creation (see
  // lib/maintenance/coordinator.ts performMaintenance rawCutoff, and
  // lib/maintenance/sql.ts DELETE_CHECKS_SQL) independently of whether
  // they've been rolled up — compaction reads from check_batches, not
  // check_results (lib/storage/sql.ts COMPACT_15_MINUTE_SQL) — so a raw row
  // and the 15m rollup bucket covering the same check routinely coexist for
  // the entire 30-day retention window. A naive COALESCE(rollup, raw) over
  // the full 24h window either double-counts (if summed together) or, as
  // written before this fix, lets one fully-covered 15m bucket mask an
  // otherwise-uncovered 24h window (young monitors, or a rollup outage gap).
  //
  // Correct approach: sum the rollups that exist in-window, then scan raw
  // checks only for the portion strictly after the last rolled-up bucket for
  // that monitor (the currently-forming bucket plus any gap since the last
  // compaction ran), falling back to the window start when the monitor has
  // no rollups yet. This never double-counts, since the raw scan and rollup
  // sum cover disjoint time ranges. A rollup outage gap in the *middle* of
  // the window (not at the tail) can still read as uncovered if its raw rows
  // were already purged by the time compaction catches up — that data is
  // simply gone and there is no way to recover it here.
  const end15m = new Date();
  end15m.setUTCMinutes(Math.floor(end15m.getUTCMinutes() / 15) * 15, 0, 0);
  const start15m = new Date(end15m.getTime() - 86_400_000);
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
            sum(${metricRollups.successfulChecks}) as successful,
            max(${metricRollups.bucketStart}) as last_bucket_start
          from ${metricRollups}
          where ${metricRollups.monitorId} = ${monitorRegistry.id}
            and ${metricRollups.resolution} = '15m'
            and ${metricRollups.bucketStart} >= ${start15m}
            and ${metricRollups.bucketStart} < ${end15m}
        ) rollup
        cross join lateral (
          select count(*) as completed,
            count(*) filter (where ${checkResults.successful}) as successful
          from ${checkResults}
          where ${checkResults.monitorId} = ${monitorRegistry.id}
            and ${checkResults.checkedAt} >= coalesce(rollup.last_bucket_start + interval '15 minutes', ${start15m})
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
