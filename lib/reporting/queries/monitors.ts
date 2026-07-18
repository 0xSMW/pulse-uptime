import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  checkResults,
  dailyRollups,
  incidents,
  monitorRegistry,
  monitoringConfigSnapshots,
  monitorState,
} from "@/lib/db/schema";
import { DEFAULT_MONITOR_VALUES } from "@/lib/config/defaults";
import { monitoringConfigSchema, type MonitorConfig } from "@/lib/config/schema";

import { buildCheckTimeline, buildDailyTimeline } from "./timeline";

function secondsBetween(start: Date, end: Date): number {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1_000));
}

function openingFailure(errorCode: string | null, statusCode: number | null): string {
  if (statusCode !== null) return `HTTP ${statusCode}`;
  return errorCode ?? "Unknown failure";
}

export async function getMonitorDetail(id: string) {
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

  const now = new Date();
  const earliest = new Date(now.getTime() - 90 * 86_400_000);
  const [metricRows, rollups, recentChecks, checks24h, recentIncidents, accepted] = await Promise.all([
    db
      .select({
        p95LatencyMs: sql<number | null>`percentile_cont(0.95) within group (order by ${checkResults.latencyMs}) filter (where ${checkResults.checkedAt} >= now() - interval '24 hours')`,
        uptime24h: sql<number | null>`100.0 * count(*) filter (where ${checkResults.successful} and ${checkResults.checkedAt} >= now() - interval '24 hours') / nullif(count(*) filter (where ${checkResults.checkedAt} >= now() - interval '24 hours'), 0)`,
        uptime7d: sql<number | null>`100.0 * count(*) filter (where ${checkResults.successful} and ${checkResults.checkedAt} >= now() - interval '7 days') / nullif(count(*) filter (where ${checkResults.checkedAt} >= now() - interval '7 days'), 0)`,
        uptime30d: sql<number | null>`100.0 * count(*) filter (where ${checkResults.successful} and ${checkResults.checkedAt} >= now() - interval '30 days') / nullif(count(*) filter (where ${checkResults.checkedAt} >= now() - interval '30 days'), 0)`,
        uptime90d: sql<number | null>`100.0 * count(*) filter (where ${checkResults.successful}) / nullif(count(*), 0)`,
      })
      .from(checkResults)
      .where(and(eq(checkResults.monitorId, id), gte(checkResults.checkedAt, earliest))),
    db.select({
      day: dailyRollups.day,
      totalChecks: dailyRollups.totalChecks,
      failedChecks: dailyRollups.failedChecks,
      incidentSeconds: dailyRollups.incidentSeconds,
    }).from(dailyRollups)
      .where(and(eq(dailyRollups.monitorId, id), gte(dailyRollups.day, earliest.toISOString().slice(0, 10))))
      .orderBy(dailyRollups.day)
      .limit(90),
    db.select({
      id: checkResults.id,
      checkedAt: checkResults.checkedAt,
      successful: checkResults.successful,
      statusCode: checkResults.statusCode,
      errorCode: checkResults.errorCode,
      latencyMs: checkResults.latencyMs,
    }).from(checkResults)
      .where(eq(checkResults.monitorId, id))
      .orderBy(desc(checkResults.checkedAt))
      .limit(240),
    db.select({
      checkedAt: checkResults.checkedAt,
      successful: checkResults.successful,
    }).from(checkResults)
      .where(and(
        eq(checkResults.monitorId, id),
        gte(checkResults.checkedAt, new Date(now.getTime() - 86_400_000)),
      ))
      .orderBy(desc(checkResults.checkedAt))
      .limit(1_500),
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

  const parsedConfig = monitoringConfigSchema.safeParse(accepted[0]?.configJson);
  const config: MonitorConfig | undefined = parsedConfig.success
    ? parsedConfig.data.monitors.find((candidate) => candidate.id === id)
    : undefined;
  const metrics = metricRows[0];
  const timeline90 = buildDailyTimeline(rollups, 90, now);
  const timeline = (days: number) => timeline90.slice(-days);
  const checksAscending = recentChecks.toReversed();
  const pointsSince = (durationMs: number) => checksAscending
    .filter((check) => check.checkedAt.getTime() >= now.getTime() - durationMs)
    .map((check) => ({
      timestamp: check.checkedAt.toISOString(),
      latencyMs: check.latencyMs,
      successful: check.successful,
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
    group: config?.group ?? monitor.group,
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
      ? (config.recipients.length || (parsedConfig.success ? parsedConfig.data.settings.defaultRecipients.length : 0))
      : 0,
    latestLatencyMs: monitor.latestLatencyMs,
    p95LatencyMs: metrics?.p95LatencyMs === null || metrics?.p95LatencyMs === undefined ? null : Number(metrics.p95LatencyMs),
    uptime: {
      h24: metrics?.uptime24h == null ? null : Number(metrics.uptime24h),
      d7: metrics?.uptime7d == null ? null : Number(metrics.uptime7d),
      d30: metrics?.uptime30d == null ? null : Number(metrics.uptime30d),
      d90: metrics?.uptime90d == null ? null : Number(metrics.uptime90d),
    },
    availability: {
      h24: {
        start: new Date(now.getTime() - 86_400_000).toISOString(),
        buckets: buildCheckTimeline(checks24h, 60, 86_400_000, now),
      },
      d7: { start: new Date(now.getTime() - 7 * 86_400_000).toISOString(), buckets: timeline(7) },
      d30: { start: new Date(now.getTime() - 30 * 86_400_000).toISOString(), buckets: timeline(30) },
      d90: { start: earliest.toISOString(), buckets: timeline90 },
    },
    responseTime: {
      h24: pointsSince(86_400_000),
      d7: pointsSince(7 * 86_400_000),
      d30: pointsSince(30 * 86_400_000),
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
    recentChecks: recentChecks.slice(0, 20).map((check) => ({
      id: check.id.toString(),
      checkedAt: check.checkedAt.toISOString(),
      successful: check.successful,
      statusCode: check.statusCode,
      resultLabel: check.statusCode !== null ? `${check.statusCode} ${check.successful ? "OK" : "Failed"}` : (check.errorCode ?? "Failed"),
      latencyMs: check.latencyMs,
    })),
  };
}
