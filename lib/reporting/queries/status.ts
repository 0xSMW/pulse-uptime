import { and, desc, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { incidents, metricRollups, monitorRegistry, monitorState } from "@/lib/db/schema";

import { buildRollupTimeline, statusGroupSlug, summarizeRollupCoverage } from "./timeline";

function failureLabel(statusCode: number | null): string {
  if (statusCode !== null) return `HTTP ${statusCode}`;
  // Checker codes can include infrastructure detail. Public pages use a stable,
  // actionable-safe label while the authenticated incident view retains the code.
  return "Availability check failed";
}

/**
 * Thrown when public status data fails to load. Status routes must catch
 * this and never let it escape as an uncaught rejection. Status pages are
 * ISR and build-time prerendered, so an unhandled failure breaks builds in
 * database-less environments (CI, preview) and 500s the public page during
 * a real outage instead of degrading to "unavailable".
 */
export class StatusDataUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Public status data is temporarily unavailable");
    this.name = "StatusDataUnavailableError";
    this.cause = cause;
  }
}

export async function getPublicStatus(group?: string) {
  try {
    return await loadPublicStatus(group);
  } catch (error) {
    if (error instanceof StatusDataUnavailableError) throw error;
    console.error("[status] failed to load public status data", error);
    throw new StatusDataUnavailableError(error);
  }
}

async function loadPublicStatus(group?: string) {
  const now = new Date();
  const completedDay = new Date(now);
  completedDay.setUTCHours(0, 0, 0, 0);
  const earliest = new Date(completedDay.getTime() - 90 * 86_400_000);
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
      monitorId: metricRollups.monitorId,
      bucketStart: metricRollups.bucketStart,
      expectedChecks: metricRollups.expectedChecks,
      completedChecks: metricRollups.completedChecks,
      successfulChecks: metricRollups.successfulChecks,
      failedChecks: metricRollups.failedChecks,
      unknownChecks: metricRollups.unknownChecks,
      downtimeSeconds: metricRollups.downtimeSeconds,
    }).from(metricRollups)
      .where(and(
        inArray(metricRollups.monitorId, ids),
        eq(metricRollups.resolution, "day"),
        gte(metricRollups.bucketStart, earliest),
        lt(metricRollups.bucketStart, completedDay),
      ))
      .orderBy(metricRollups.bucketStart)
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
        const summary = summarizeRollupCoverage(rows);
        return {
          id: monitor.id,
          name: monitor.name,
          state: monitor.state === "ARCHIVED" || monitor.state === null ? "PENDING" as const : monitor.state,
          uptime90d: summary.uptime,
          coverage90d: summary.coverage,
          timeline: buildRollupTimeline(rows, 90, 90 * 86_400_000, completedDay),
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
