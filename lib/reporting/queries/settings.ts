import { and, desc, eq, gt, isNull } from "drizzle-orm";

import { validateMonitoringConfig, type MonitoringConfig } from "@/lib/config";
import { DEFAULT_MONITOR_VALUES } from "@/lib/config/defaults";
import { getStatusPageConfig } from "@/lib/api/status-page-config";
import { parseUserAgent } from "@/lib/auth/user-agent";
import { db } from "@/lib/db/client";
import { getDatabaseHealth } from "@/lib/database-health";
import {
  adminUsers,
  apiTokens,
  cliInstallations,
  cliSessions,
  humanSessions,
  monitorRegistry,
  monitoringConfigSnapshots,
  monitorState,
} from "@/lib/db/schema";

async function getAcceptedConfig(): Promise<MonitoringConfig | null> {
  const accepted = await db.select({ configJson: monitoringConfigSnapshots.configJson })
    .from(monitoringConfigSnapshots)
    .where(eq(monitoringConfigSnapshots.status, "accepted"))
    .orderBy(desc(monitoringConfigSnapshots.acceptedAt))
    .limit(1);
  try {
    return accepted[0] ? validateMonitoringConfig(accepted[0].configJson) : null;
  } catch {
    return null;
  }
}

export async function getMonitorSettings() {
  const [registrations, config] = await Promise.all([
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
    getAcceptedConfig(),
  ]);
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
    userAgent: config?.settings.userAgent ?? "Not configured",
  };
}

export async function getNotificationSettings() {
  const config = await getAcceptedConfig();
  return {
    defaultRecipients: config?.settings.defaultRecipients ?? [],
    sender: process.env.RESEND_FROM_EMAIL?.trim() || null,
  };
}

export async function getAccountSettings(userId: string) {
  const [row] = await db.select({
    name: adminUsers.name,
    email: adminUsers.email,
    timezone: adminUsers.timezone,
    avatarImageId: adminUsers.avatarImageId,
  }).from(adminUsers).where(eq(adminUsers.id, userId)).limit(1);
  return row ?? null;
}

const sessionColumns = {
  id: humanSessions.id,
  userAgent: humanSessions.userAgent,
  ipAddress: humanSessions.ipAddress,
  createdAt: humanSessions.createdAt,
  lastSeenAt: humanSessions.lastSeenAt,
};

export async function getSecuritySettings(userId: string, currentSessionId: string, now = new Date()) {
  const activeFilter = and(
    eq(humanSessions.userId, userId),
    isNull(humanSessions.revokedAt),
    gt(humanSessions.expiresAt, now),
  );
  const rows = await db.select(sessionColumns).from(humanSessions)
    .where(activeFilter)
    .orderBy(desc(humanSessions.createdAt))
    .limit(100);

  // The 100-row cap ranks by recency, so a session that's still current but
  // was created long ago could rank past the cutoff and be dropped entirely
  // (finding: the page then shows no "current session" row at all, even
  // though the caller is using that very session right now). Rather than
  // trust recency alone to carry it, fetch the current session directly by
  // id whenever the capped batch didn't already include it, and prepend it —
  // still subject to the same active-session bounds, so a revoked or expired
  // "current" session is intentionally not force-included.
  let allRows = rows;
  if (!rows.some((row) => row.id === currentSessionId)) {
    const currentRows = await db.select(sessionColumns).from(humanSessions)
      .where(and(eq(humanSessions.id, currentSessionId), activeFilter))
      .limit(1);
    if (currentRows[0]) allRows = [currentRows[0], ...rows];
  }

  const sessions = allRows.map((row) => {
    const { browser, os } = parseUserAgent(row.userAgent);
    return {
      id: row.id,
      browser,
      os,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      current: row.id === currentSessionId,
    };
  });
  // Current session first; the rest keep newest-signed-in order (stable sort).
  sessions.sort((left, right) => Number(right.current) - Number(left.current));
  return { sessions };
}

export async function getStatusPageSettings() {
  const { data, etag } = await getStatusPageConfig();
  const { updatedAt: _updatedAt, ...document } = data;
  void _updatedAt;
  return {
    // The full document (including the current logo/favicon image ids) is the
    // page's single draft; the ETag rides along for the If-Match PUT.
    config: document,
    etag,
  };
}

export async function getSystemSettings() {
  const databaseHealthResult = await getDatabaseHealth()
    .then((data) => ({ data, error: false }))
    .catch(() => ({ data: null, error: true }));
  return {
    databaseHealth: databaseHealthResult.data,
    databaseHealthError: databaseHealthResult.error,
  };
}

export async function getAccessSettings() {
  const [agentTokens, sessions] = await Promise.all([
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
  ]);

  return {
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
  };
}
