import { and, desc, eq, gte, isNull, lt } from "drizzle-orm";
import { cache } from "react";

import { db } from "@/lib/db/client";
import {
  incidents,
  metricRollups,
  monitorRegistry,
  monitoringConfigSnapshots,
  monitorState,
} from "@/lib/db/schema";
import { DEFAULT_MONITOR_VALUES } from "@/lib/config/defaults";
import { validateMonitoringConfig, type MonitorConfig } from "@/lib/config";

import { buildRollupTimeline, summarizeRollupCoverage } from "./timeline";

function secondsBetween(start: Date, end: Date): number {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1_000));
}

function openingFailure(errorCode: string | null, statusCode: number | null): string {
  if (statusCode !== null) return `HTTP ${statusCode}`;
  return errorCode ?? "Unknown failure";
}

const LATENCY_BUCKET_MAX_MS = [100, 250, 500, 1_000, 2_500, 5_000, 10_000] as const;

function completedRangeEnd(now: Date, resolution: "15m" | "hour" | "day"): Date {
  const end = new Date(now);
  if (resolution === "day") {
    end.setUTCHours(0, 0, 0, 0);
  } else if (resolution === "hour") {
    end.setUTCMinutes(0, 0, 0);
  } else {
    end.setUTCMinutes(Math.floor(end.getUTCMinutes() / 15) * 15, 0, 0);
  }
  return end;
}

// Re-derives a narrower [cutoffMs, endMs) window from a superset of rows that
// is already known to be sorted ascending by bucketStart and bounded above by
// endMs — equivalent to a second `gte(bucketStart, cutoff) AND lt(bucketStart, end)`
// SQL query, without a second round trip.
export function selectRecentRollupWindow<T extends { bucketStart: Date }>(
  supersetRows: T[],
  cutoffMs: number,
  endMs: number,
): T[] {
  return supersetRows.filter((row) => {
    const bucketMs = row.bucketStart.getTime();
    return bucketMs >= cutoffMs && bucketMs < endMs;
  });
}

function p95Latency(rows: Array<{
  latencyCount: number;
  latencyHistogram: number[];
  latencyMaxMs: number | null;
}>): number | null {
  const count = rows.reduce((sum, row) => sum + row.latencyCount, 0);
  if (count === 0) return null;

  const rank = Math.ceil(count * 0.95);
  let cumulative = 0;
  for (let index = 0; index < 8; index += 1) {
    cumulative += rows.reduce((sum, row) => sum + (row.latencyHistogram[index] ?? 0), 0);
    if (cumulative >= rank) {
      return index < LATENCY_BUCKET_MAX_MS.length
        ? LATENCY_BUCKET_MAX_MS[index]!
        : Math.max(...rows.map((row) => row.latencyMaxMs ?? 0));
    }
  }
  return null;
}

// Cheap identity lookup for the page shell — one indexed query, no rollups.
// cache(): the page (shell/404 check) and the detail island share one lookup
// per request.
export const getMonitorIdentity = cache(async (id: string) => {
  const [monitor] = await db
    .select({
      id: monitorRegistry.id,
      name: monitorRegistry.name,
      url: monitorRegistry.url,
      group: monitorRegistry.groupName,
      enabled: monitorRegistry.enabled,
      state: monitorState.state,
      latestLatencyMs: monitorState.lastLatencyMs,
    })
    .from(monitorRegistry)
    .leftJoin(monitorState, eq(monitorState.monitorId, monitorRegistry.id))
    .where(and(eq(monitorRegistry.id, id), isNull(monitorRegistry.archivedAt)))
    .limit(1);
  if (!monitor || monitor.state === "ARCHIVED") return null;
  return { ...monitor, state: monitor.state ?? ("PENDING" as const) };
});

export type MonitorIdentity = NonNullable<Awaited<ReturnType<typeof getMonitorIdentity>>>;

export async function getMonitorDetail(id: string) {
  const monitor = await getMonitorIdentity(id);
  if (!monitor) return null;

  const now = new Date();
  const end15m = completedRangeEnd(now, "15m");
  const endHour = completedRangeEnd(now, "hour");
  const endDay = completedRangeEnd(now, "day");
  const rollupColumns = {
    bucketStart: metricRollups.bucketStart,
    expectedChecks: metricRollups.expectedChecks,
    completedChecks: metricRollups.completedChecks,
    successfulChecks: metricRollups.successfulChecks,
    failedChecks: metricRollups.failedChecks,
    unknownChecks: metricRollups.unknownChecks,
    downtimeSeconds: metricRollups.downtimeSeconds,
    latencyCount: metricRollups.latencyCount,
    latencySumMs: metricRollups.latencySumMs,
    latencyMaxMs: metricRollups.latencyMaxMs,
    latencyHistogram: metricRollups.latencyHistogram,
  };
  const rollupsFor = (resolution: "15m" | "hour" | "day", end: Date, durationMs: number) => db
    .select(rollupColumns)
    .from(metricRollups)
    .where(and(
      eq(metricRollups.monitorId, id),
      eq(metricRollups.resolution, resolution),
      gte(metricRollups.bucketStart, new Date(end.getTime() - durationMs)),
      lt(metricRollups.bucketStart, end),
    ))
    .orderBy(metricRollups.bucketStart);
  const [rollups7d, rollups30d, rollups90d, recentIncidents, accepted] = await Promise.all([
    rollupsFor("15m", end15m, 7 * 86_400_000),
    rollupsFor("hour", endHour, 30 * 86_400_000),
    rollupsFor("day", endDay, 90 * 86_400_000),
    db.select().from(incidents)
      .where(eq(incidents.monitorId, id))
      .orderBy(desc(incidents.openedAt))
      .limit(5),
    db.select({ configJson: monitoringConfigSnapshots.configJson })
      .from(monitoringConfigSnapshots)
      .where(eq(monitoringConfigSnapshots.status, "accepted"))
      .orderBy(desc(monitoringConfigSnapshots.acceptedAt))
      .limit(1),
  ]);

  // rollups7d is a strict superset of the 24h window (same end, wider start), fetched
  // ascending — re-derive 24h in memory instead of issuing a second 15m rollup query.
  const rollups24h = selectRecentRollupWindow(rollups7d, end15m.getTime() - 86_400_000, end15m.getTime());

  let acceptedConfig = null;
  try { acceptedConfig = accepted[0] ? validateMonitoringConfig(accepted[0].configJson) : null; } catch { acceptedConfig = null; }
  const config: MonitorConfig | undefined = acceptedConfig?.monitors.find((candidate) => candidate.id === id);
  const groupName = config?.groupId ? acceptedConfig?.groups.find((group) => group.id === config.groupId)?.name ?? monitor.group : null;
  const responsePoints = (rows: typeof rollups24h) => rows
    .filter((row) => row.latencyCount > 0)
    .map((row) => ({
      timestamp: row.bucketStart.toISOString(),
      latencyMs: Number(row.latencySumMs) / row.latencyCount,
      successful: row.failedChecks === 0 && row.completedChecks === row.expectedChecks,
    }));
  const mappedIncidents = recentIncidents.map((incident) => ({
    id: incident.id,
    openedAt: incident.openedAt.toISOString(),
    durationSeconds: secondsBetween(incident.openedAt, incident.resolvedAt ?? now),
    openingFailure: openingFailure(incident.openingErrorCode, incident.openingStatusCode),
  }));

  return {
    id: monitor.id,
    name: monitor.name,
    url: monitor.url,
    method: config?.method ?? DEFAULT_MONITOR_VALUES.method,
    groupId: config?.groupId ?? null,
    group: groupName,
    enabled: config?.enabled ?? monitor.enabled,
    intervalMinutes: config?.intervalMinutes ?? DEFAULT_MONITOR_VALUES.intervalMinutes,
    timeoutMs: config?.timeoutMs ?? DEFAULT_MONITOR_VALUES.timeoutMs,
    recipients: config?.recipients ?? [],
    state: monitor.state ?? "PENDING",
    intervalSeconds: (config?.intervalMinutes ?? DEFAULT_MONITOR_VALUES.intervalMinutes) * 60,
    timeoutSeconds: (config?.timeoutMs ?? DEFAULT_MONITOR_VALUES.timeoutMs) / 1_000,
    expectedStatusMin: config?.expectedStatus.minimum ?? DEFAULT_MONITOR_VALUES.expectedStatus.minimum,
    expectedStatusMax: config?.expectedStatus.maximum ?? DEFAULT_MONITOR_VALUES.expectedStatus.maximum,
    failureThreshold: config?.failureThreshold ?? DEFAULT_MONITOR_VALUES.failureThreshold,
    recoveryThreshold: config?.recoveryThreshold ?? DEFAULT_MONITOR_VALUES.recoveryThreshold,
    recipientCount: config
      ? (config.recipients.length || (acceptedConfig?.settings.defaultRecipients.length ?? 0))
      : 0,
    latestLatencyMs: monitor.latestLatencyMs,
    p95LatencyMs: p95Latency(rollups24h),
    uptime: {
      h24: summarizeRollupCoverage(rollups24h).uptime,
      d7: summarizeRollupCoverage(rollups7d).uptime,
      d30: summarizeRollupCoverage(rollups30d).uptime,
      d90: summarizeRollupCoverage(rollups90d).uptime,
    },
    availability: {
      h24: {
        start: new Date(end15m.getTime() - 86_400_000).toISOString(),
        buckets: buildRollupTimeline(rollups24h, 60, 86_400_000, end15m),
      },
      d7: {
        start: new Date(end15m.getTime() - 7 * 86_400_000).toISOString(),
        buckets: buildRollupTimeline(rollups7d, 84, 7 * 86_400_000, end15m),
      },
      d30: {
        start: new Date(endHour.getTime() - 30 * 86_400_000).toISOString(),
        buckets: buildRollupTimeline(rollups30d, 90, 30 * 86_400_000, endHour),
      },
      d90: {
        start: new Date(endDay.getTime() - 90 * 86_400_000).toISOString(),
        buckets: buildRollupTimeline(rollups90d, 90, 90 * 86_400_000, endDay),
      },
    },
    responseTime: {
      h24: responsePoints(rollups24h),
      d7: responsePoints(rollups7d),
      d30: responsePoints(rollups30d),
    },
    latestIncident: recentIncidents[0] && (
      recentIncidents[0].resolvedAt === null ||
      recentIncidents[0].resolvedAt.getTime() >= now.getTime() - 86_400_000
    ) ? {
      id: recentIncidents[0].id,
      state: recentIncidents[0].resolvedAt ? "RESOLVED" as const : "ONGOING" as const,
      openedAt: recentIncidents[0].openedAt.toISOString(),
      resolvedAt: recentIncidents[0].resolvedAt?.toISOString() ?? null,
      durationSeconds: secondsBetween(recentIncidents[0].openedAt, recentIncidents[0].resolvedAt ?? now),
      openingFailure: openingFailure(recentIncidents[0].openingErrorCode, recentIncidents[0].openingStatusCode),
    } : null,
    recentIncidents: mappedIncidents,
    recentChecks: rollups24h.slice(-20).toReversed().map((rollup) => ({
      id: `15m:${rollup.bucketStart.toISOString()}`,
      checkedAt: rollup.bucketStart.toISOString(),
      successful: rollup.failedChecks === 0 && rollup.completedChecks === rollup.expectedChecks,
      statusCode: null,
      resultLabel: rollup.unknownChecks > 0 ? "Unknown coverage" : rollup.failedChecks > 0 ? "Failed checks" : "Healthy rollup",
      latencyMs: rollup.latencyCount === 0 ? null : Math.round(Number(rollup.latencySumMs) / rollup.latencyCount),
    })),
  };
}
