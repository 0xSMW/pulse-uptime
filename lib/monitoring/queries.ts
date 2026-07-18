import { and, eq, isNull, sql as dsql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { checkResults, incidents, monitorRegistry, monitorState } from "@/lib/db/schema";

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
        select case when count(*) = 0 then null
          else 100.0 * count(*) filter (where ${checkResults.successful}) / count(*) end
        from ${checkResults}
        where ${checkResults.monitorId} = ${monitorRegistry.id}
          and ${checkResults.checkedAt} >= now() - interval '24 hours'
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
