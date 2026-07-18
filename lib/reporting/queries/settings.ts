import { and, desc, eq, isNull } from "drizzle-orm";

import { validateMonitoringConfig } from "@/lib/config";
import { DEFAULT_MONITOR_VALUES } from "@/lib/config/defaults";
import { db } from "@/lib/db/client";
import { getDatabaseHealth } from "@/lib/database-health";
import {
  apiTokens,
  cliInstallations,
  cliSessions,
  monitorRegistry,
  monitoringConfigSnapshots,
  monitorState,
} from "@/lib/db/schema";

export async function getSettingsOverview() {
  const [registrations, accepted, agentTokens, sessions, databaseHealthResult] = await Promise.all([
    db.select({
      id: monitorRegistry.id,
      name: monitorRegistry.name,
      url: monitorRegistry.url,
      state: monitorState.state,
      enabled: monitorRegistry.enabled,
      group: monitorRegistry.groupName,
    }).from(monitorRegistry)
      .leftJoin(monitorState, eq(monitorState.monitorId, monitorRegistry.id))
      .where(isNull(monitorRegistry.archivedAt))
      .orderBy(monitorRegistry.name)
      .limit(100),
    db.select({ configJson: monitoringConfigSnapshots.configJson })
      .from(monitoringConfigSnapshots)
      .where(eq(monitoringConfigSnapshots.status, "accepted"))
      .orderBy(desc(monitoringConfigSnapshots.acceptedAt))
      .limit(1),
    db.select({
      id: apiTokens.id,
      name: apiTokens.name,
      prefix: apiTokens.tokenPrefix,
      scopes: apiTokens.scopes,
      expiresAt: apiTokens.expiresAt,
      lastUsedAt: apiTokens.lastUsedAt,
    }).from(apiTokens)
      .where(isNull(apiTokens.revokedAt))
      .orderBy(desc(apiTokens.createdAt))
      .limit(100),
    db.select({
      id: cliSessions.id,
      prefix: cliSessions.tokenPrefix,
      scopes: cliSessions.scopes,
      expiresAt: cliSessions.expiresAt,
      lastUsedAt: cliSessions.lastUsedAt,
      displayName: cliInstallations.displayName,
      platform: cliInstallations.platform,
      architecture: cliInstallations.architecture,
    }).from(cliSessions)
      .innerJoin(cliInstallations, eq(cliInstallations.id, cliSessions.installationId))
      .where(and(isNull(cliSessions.revokedAt), isNull(cliInstallations.revokedAt)))
      .orderBy(desc(cliSessions.createdAt))
      .limit(100),
    getDatabaseHealth()
      .then((data) => ({ data, error: false }))
      .catch(() => ({ data: null, error: true })),
  ]);
  let config = null;
  try { config = accepted[0] ? validateMonitoringConfig(accepted[0].configJson) : null; } catch { config = null; }
  const configById = new Map(config?.monitors.map((monitor) => [monitor.id, monitor]) ?? []);
  const groupNames = new Map(config?.groups.map((group) => [group.id, group.name]) ?? []);

  return {
    monitors: registrations.map((monitor) => {
      const details = configById.get(monitor.id);
      return {
        ...monitor,
        groupId: details?.groupId ?? null,
        group: details?.groupId ? groupNames.get(details.groupId) ?? monitor.group : null,
        state: monitor.state === "ARCHIVED" || monitor.state === null ? "PENDING" as const : monitor.state,
        method: details?.method ?? DEFAULT_MONITOR_VALUES.method,
        intervalMinutes: details?.intervalMinutes ?? DEFAULT_MONITOR_VALUES.intervalMinutes,
        timeoutMs: details?.timeoutMs ?? DEFAULT_MONITOR_VALUES.timeoutMs,
        expectedStatusMin: details?.expectedStatus.minimum ?? DEFAULT_MONITOR_VALUES.expectedStatus.minimum,
        expectedStatusMax: details?.expectedStatus.maximum ?? DEFAULT_MONITOR_VALUES.expectedStatus.maximum,
        failureThreshold: details?.failureThreshold ?? DEFAULT_MONITOR_VALUES.failureThreshold,
        recoveryThreshold: details?.recoveryThreshold ?? DEFAULT_MONITOR_VALUES.recoveryThreshold,
        recipients: details?.recipients ?? [],
      };
    }),
    groups: (config?.groups ?? []).map((group) => ({
      ...group,
      monitorCount: config?.monitors.filter((monitor) => monitor.groupId === group.id).length ?? 0,
    })),
    notifications: {
      defaultRecipients: config?.settings.defaultRecipients ?? [],
      userAgent: config?.settings.userAgent ?? "Not configured",
      sender: process.env.RESEND_FROM_EMAIL?.trim() || null,
    },
    tokens: [
      ...agentTokens.map((token) => ({
        id: token.id,
        name: token.name,
        kind: "agent" as const,
        detail: null,
        prefix: token.prefix,
        scopes: token.scopes,
        expiresAt: token.expiresAt.toISOString(),
        lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
      })),
      ...sessions.map((session) => ({
        id: session.id,
        name: session.displayName,
        kind: "cli" as const,
        detail: `${session.platform}/${session.architecture}`,
        prefix: session.prefix,
        scopes: session.scopes,
        expiresAt: session.expiresAt.toISOString(),
        lastUsedAt: session.lastUsedAt?.toISOString() ?? null,
      })),
    ],
    origin: process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "",
    databaseHealth: databaseHealthResult.data,
    databaseHealthError: databaseHealthResult.error,
  };
}
