import { and, eq, isNull, sql as dsql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { incidents, metricRollups, monitorRegistry, monitorState } from "@/lib/db/schema";

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
  // Uptime from pre-aggregated 15m rollups instead of rescanning 24h of raw
  // check_results per monitor. Rollups close at quarter-hour boundaries, so
  // the figure lags up to 15 minutes — acceptable for a 24h aggregate; the
  // state/latency columns stay real-time.
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
        select case when coalesce(sum(${metricRollups.completedChecks}), 0) = 0 then null
          else 100.0 * sum(${metricRollups.successfulChecks}) / sum(${metricRollups.completedChecks}) end
        from ${metricRollups}
        where ${metricRollups.monitorId} = ${monitorRegistry.id}
          and ${metricRollups.resolution} = '15m'
          and ${metricRollups.bucketStart} >= ${start15m}
          and ${metricRollups.bucketStart} < ${end15m}
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
