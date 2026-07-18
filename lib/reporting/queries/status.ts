import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { dailyRollups, incidents, monitorRegistry, monitorState } from "@/lib/db/schema";

import { buildDailyTimeline, statusGroupSlug } from "./timeline";

function failureLabel(statusCode: number | null): string {
  if (statusCode !== null) return `HTTP ${statusCode}`;
  // Checker codes can include infrastructure detail. Public pages use a stable,
  // actionable-safe label while the authenticated incident view retains the code.
  return "Availability check failed";
}

export async function getPublicStatus(group?: string) {
  const now = new Date();
  const earliestDay = new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
  const monitors = await db.select({
    id: monitorRegistry.id,
    name: monitorRegistry.name,
    groupName: monitorRegistry.groupName,
    state: monitorState.state,
  }).from(monitorRegistry)
    .leftJoin(monitorState, eq(monitorState.monitorId, monitorRegistry.id))
    .where(and(eq(monitorRegistry.enabled, true), isNull(monitorRegistry.archivedAt)))
    .limit(100);
  const visible = group
    ? monitors.filter((monitor) => statusGroupSlug(monitor.groupName ?? "Other") === group)
    : monitors;
  if (group && visible.length === 0) return null;

  const ids = visible.map((monitor) => monitor.id);
  const [rollups, current, recent] = ids.length === 0 ? [[], [], []] : await Promise.all([
    db.select({
      monitorId: dailyRollups.monitorId,
      day: dailyRollups.day,
      totalChecks: dailyRollups.totalChecks,
      successfulChecks: dailyRollups.successfulChecks,
      failedChecks: dailyRollups.failedChecks,
      incidentSeconds: dailyRollups.incidentSeconds,
    }).from(dailyRollups)
      .where(and(inArray(dailyRollups.monitorId, ids), gte(dailyRollups.day, earliestDay)))
      .orderBy(dailyRollups.day)
      .limit(9_000),
    db.select({
      id: incidents.id,
      monitorName: monitorRegistry.name,
      openedAt: incidents.openedAt,
      openingStatusCode: incidents.openingStatusCode,
    }).from(incidents)
      .innerJoin(monitorRegistry, eq(monitorRegistry.id, incidents.monitorId))
      .where(and(inArray(incidents.monitorId, ids), isNull(incidents.resolvedAt)))
      .orderBy(desc(incidents.openedAt))
      .limit(100),
    db.select({
      id: incidents.id,
      monitorName: monitorRegistry.name,
      openedAt: incidents.openedAt,
      resolvedAt: incidents.resolvedAt,
    }).from(incidents)
      .innerJoin(monitorRegistry, eq(monitorRegistry.id, incidents.monitorId))
      .where(and(inArray(incidents.monitorId, ids), isNotNull(incidents.resolvedAt)))
      .orderBy(desc(incidents.resolvedAt))
      .limit(10),
  ]);

  const grouped = new Map<string, typeof visible>();
  for (const monitor of visible) {
    const name = monitor.groupName ?? "Other";
    grouped.set(name, [...(grouped.get(name) ?? []), monitor]);
  }
  const groups = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entries]) => ({
      name,
      slug: statusGroupSlug(name),
      monitors: entries.sort((left, right) => left.name.localeCompare(right.name)).map((monitor) => {
        const rows = rollups.filter((rollup) => rollup.monitorId === monitor.id);
        const total = rows.reduce((sum, row) => sum + row.totalChecks, 0);
        const successful = rows.reduce((sum, row) => sum + row.successfulChecks, 0);
        return {
          id: monitor.id,
          name: monitor.name,
          state: monitor.state === "ARCHIVED" || monitor.state === null ? "PENDING" as const : monitor.state,
          uptime90d: total === 0 ? null : 100 * successful / total,
          timeline: buildDailyTimeline(rows, 90, now),
        };
      }),
    }));
  const states = visible.map((monitor) => monitor.state ?? "PENDING");
  const overallState = visible.length === 0
    ? "empty" as const
    : states.includes("DOWN")
      ? "outage" as const
      : states.some((state) => state === "VERIFYING_DOWN" || state === "VERIFYING_UP")
        ? "investigating" as const
        : "operational" as const;
  return {
    pageName: process.env.NEXT_PUBLIC_STATUS_PAGE_NAME?.trim() || "System Status",
    lastUpdatedAt: now.toISOString(),
    overallState,
    currentIncidents: current.map((incident) => ({
      id: incident.id,
      monitorName: incident.monitorName,
      openedAt: incident.openedAt.toISOString(),
      elapsedSeconds: Math.max(0, Math.floor((now.getTime() - incident.openedAt.getTime()) / 1_000)),
      cause: failureLabel(incident.openingStatusCode),
    })),
    groups,
    recentIncidents: recent.map((incident) => ({
      id: incident.id,
      monitorName: incident.monitorName,
      openedAt: incident.openedAt.toISOString(),
      durationSeconds: Math.max(0, Math.floor(((incident.resolvedAt?.getTime() ?? now.getTime()) - incident.openedAt.getTime()) / 1_000)),
    })),
  };
}
