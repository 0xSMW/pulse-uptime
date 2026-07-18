import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { createClient } from "@vercel/edge-config";
import { and, desc, eq, gt, isNull, notInArray, sql as drizzleSql } from "drizzle-orm";

import { createHttpChecker } from "@/lib/checker/checker";
import {
  evaluateConfigurationAcceptance,
  hashCanonical,
  type MonitoringConfig,
} from "@/lib/config";
import { db, sql } from "@/lib/db/client";
import { portableQueryValues } from "@/lib/db/query-values";
import {
  configChangeApprovals,
  configOperations,
  incidents,
  monitorRegistry,
  monitorExceptions,
  monitoringConfigSnapshots,
  monitorState,
} from "@/lib/db/schema";
import type { MonitorStateSnapshot } from "@/lib/monitoring/types";
import { deliverPendingNotifications } from "@/lib/notifications/delivery";
import { createResendSender } from "@/lib/notifications/provider";
import { reconcileStaleClaims, type SqlExecutor } from "@/lib/notifications/sql";
import { persistAtomicMinute, type CompletedMinuteCheck } from "@/lib/storage/atomic-minute";

import { runMonitoringCoordinator } from "./coordinator";
import { evaluateConfigurationSource, requireApprovalConsumption } from "./configuration";
import { targetFor, transitionLifecycle } from "./lifecycle";
import { createSqlCronRunStore, createSqlLeaseStore } from "./sql";
import { isDueAt } from "./time";

type AcceptedRow = {
  configJson: unknown;
  configHash: string;
};

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash("sha256").update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const queryExecutor: SqlExecutor = {
  async query<T>(text: string, values: readonly unknown[]): Promise<readonly T[]> {
    return await sql.unsafe(text, portableQueryValues(values) as never[]) as unknown as readonly T[];
  },
};

async function synchronizeRegistry(config: MonitoringConfig, hash: string, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const applyLifecycle = async (monitorId: string, enabled: boolean, archived: boolean) => {
      const [current] = await tx.select().from(monitorState)
        .where(eq(monitorState.monitorId, monitorId)).for("update");
      if (!current) throw new Error(`Monitor state not found: ${monitorId}`);
      const mutation = transitionLifecycle(current, targetFor(enabled, archived), now);
      if (!mutation.changed) return;
      if (mutation.resolution) {
        const resolved = await tx.update(incidents).set({
          firstSuccessAt: mutation.resolution.resolvedAt,
          resolvedAt: mutation.resolution.resolvedAt,
          resolutionReason: mutation.resolution.reason,
          updatedAt: now,
        }).where(and(
          eq(incidents.id, mutation.resolution.incidentId),
          isNull(incidents.resolvedAt),
        )).returning({ id: incidents.id });
        if (resolved.length !== 1) throw new Error(`Active incident not found: ${mutation.resolution.incidentId}`);
      }
      await tx.update(monitorState).set({
        state: mutation.state.state,
        consecutiveFailures: mutation.state.consecutiveFailures,
        consecutiveSuccesses: mutation.state.consecutiveSuccesses,
        firstFailureAt: mutation.state.firstFailureAt,
        firstSuccessAt: mutation.state.firstSuccessAt,
        activeIncidentId: mutation.state.activeIncidentId,
        version: mutation.state.version,
        updatedAt: mutation.state.updatedAt,
      }).where(eq(monitorState.monitorId, monitorId));
    };

    for (const monitor of config.monitors) {
      const [previousRegistry] = await tx.select().from(monitorRegistry)
        .where(eq(monitorRegistry.id, monitor.id));
      await tx.insert(monitorRegistry).values({
        id: monitor.id,
        name: monitor.name,
        url: monitor.url,
        groupName: monitor.group,
        enabled: monitor.enabled,
        configHash: hash,
        firstSeenAt: now,
        lastSeenAt: now,
        archivedAt: null,
      }).onConflictDoUpdate({
        target: monitorRegistry.id,
        set: {
          name: monitor.name,
          url: monitor.url,
          groupName: monitor.group,
          enabled: monitor.enabled,
          configHash: hash,
          lastSeenAt: now,
          archivedAt: null,
        },
      });
      await tx.insert(monitorState).values({
        monitorId: monitor.id,
        state: monitor.enabled ? "PENDING" : "PAUSED",
        updatedAt: now,
      }).onConflictDoNothing();
      await applyLifecycle(monitor.id, monitor.enabled, false);
      const exceptionTypes = [
        ...(previousRegistry && previousRegistry.configHash !== hash ? ["configuration" as const] : []),
        ...(previousRegistry && previousRegistry.enabled !== monitor.enabled
          ? [monitor.enabled ? "resume" as const : "pause" as const]
          : []),
      ];
      for (const eventType of exceptionTypes) {
        const identity = `${eventType}/${monitor.id}/${hash}`;
        await tx.insert(monitorExceptions).values({
          id: deterministicUuid(identity),
          monitorId: monitor.id,
          eventType,
          errorCode: null,
          identityHash: createHash("sha256").update(identity).digest(),
          firstSeenAt: now,
          lastSeenAt: now,
          occurrenceCount: 1,
        }).onConflictDoNothing();
      }
    }

    const ids = config.monitors.map((monitor) => monitor.id);
    const removal = ids.length > 0 ? notInArray(monitorRegistry.id, ids) : drizzleSql`true`;
    const removed = await tx.update(monitorRegistry).set({
      enabled: false,
      archivedAt: now,
      lastSeenAt: now,
    }).where(and(isNull(monitorRegistry.archivedAt), removal)).returning({ id: monitorRegistry.id });
    for (const row of removed) {
      await applyLifecycle(row.id, false, true);
      for (const eventType of ["pause", "configuration"] as const) {
        const identity = `${eventType}/${row.id}/${hash}`;
        await tx.insert(monitorExceptions).values({
          id: deterministicUuid(identity),
          monitorId: row.id,
          eventType,
          errorCode: eventType === "pause" ? "MONITOR_ARCHIVED" : null,
          identityHash: createHash("sha256").update(identity).digest(),
          firstSeenAt: now,
          lastSeenAt: now,
          occurrenceCount: 1,
        }).onConflictDoNothing();
      }
    }
  });
}

async function loadAcceptedConfiguration(now: Date): Promise<MonitoringConfig> {
  const [last] = await db.select({
    configJson: monitoringConfigSnapshots.configJson,
    configHash: monitoringConfigSnapshots.configHash,
  }).from(monitoringConfigSnapshots)
    .where(eq(monitoringConfigSnapshots.status, "accepted"))
    .orderBy(desc(monitoringConfigSnapshots.acceptedAt), desc(monitoringConfigSnapshots.seenAt))
    .limit(1) as AcceptedRow[];
  const previous = last ? { config: last.configJson as MonitoringConfig, hash: last.configHash } : null;
  const connection = process.env.EDGE_CONFIG;
  const source = await evaluateConfigurationSource({
    readDesired: async () => {
      if (!connection) throw new Error("Edge Config is unavailable");
      return createClient(connection).get("monitoring");
    },
    previous,
    now,
  });
  const desired = source.desired;
  let result = source.result;
  let approvalId: string | null = null;
  if (result.status === "rejected" && result.reason === "DESTRUCTIVE_APPROVAL_REQUIRED" && result.candidateHash) {
    const [approval] = await db.select().from(configChangeApprovals).where(and(
      eq(configChangeApprovals.targetConfigHash, result.candidateHash),
      eq(configChangeApprovals.action, "bulk_archive"),
      isNull(configChangeApprovals.consumedAt),
      gt(configChangeApprovals.expiresAt, now),
    )).orderBy(desc(configChangeApprovals.createdAt)).limit(1);
    if (approval) {
      approvalId = approval.id;
      result = evaluateConfigurationAcceptance(desired, previous, { approval, now });
    }
  }
  if (result.status === "unavailable") {
    await db.insert(monitoringConfigSnapshots).values({
      id: randomUUID(),
      configVersion: 0,
      configHash: hashCanonical(desired ?? null),
      configJson: desired ?? null,
      status: "rejected",
      rejectionReason: result.reason,
      source: "edge-config",
      seenAt: now,
      acceptedAt: null,
    });
    console.error(JSON.stringify({ event: "config.rejected", errorCode: result.reason }));
    throw new Error(result.reason);
  }

  result = await db.transaction(async (tx) => {
    const guarded = await requireApprovalConsumption({
      result,
      desired,
      previous,
      now,
      consume: async () => {
        if (!approvalId) return false;
        const rows = await tx.update(configChangeApprovals).set({ consumedAt: now }).where(and(
          eq(configChangeApprovals.id, approvalId),
          isNull(configChangeApprovals.consumedAt),
          gt(configChangeApprovals.expiresAt, now),
        )).returning({ id: configChangeApprovals.id });
        return rows.length === 1;
      },
    });
    if (guarded.status === "unavailable") throw new Error(guarded.reason);
    await tx.insert(monitoringConfigSnapshots).values({
      id: randomUUID(),
      configVersion: guarded.config.configVersion,
      configHash: guarded.status === "accepted" ? guarded.hash : guarded.candidateHash ?? hashCanonical(desired ?? null),
      configJson: desired ?? guarded.config,
      status: guarded.status,
      rejectionReason: guarded.status === "rejected" ? guarded.reason : null,
      source: "edge-config",
      seenAt: now,
      acceptedAt: guarded.status === "accepted" ? now : null,
    });
    if (guarded.status === "accepted") {
      await tx.update(configOperations).set({ state: "accepted", acceptedAt: now })
        .where(and(eq(configOperations.targetConfigHash, guarded.hash), eq(configOperations.state, "written")));
    } else if (guarded.candidateHash) {
      await tx.update(configOperations).set({ state: "rejected", rejectionReason: guarded.reason })
        .where(and(eq(configOperations.targetConfigHash, guarded.candidateHash), eq(configOperations.state, "written")));
    }
    return guarded;
  });
  await synchronizeRegistry(result.config, result.hash, now);
  console[result.status === "accepted" ? "info" : "warn"](JSON.stringify({
    event: result.status === "accepted" ? "config.accepted" : "config.rejected",
    status: result.status,
    ...(result.status === "rejected" ? { errorCode: result.reason } : {}),
  }));
  if (result.status === "rejected") {
    console.warn(JSON.stringify({ event: "config.fallback_used", status: "active" }));
  }
  return result.config;
}

export async function runMonitoringCron() {
  let activeConfig: MonitoringConfig | null = null;
  let stateSnapshots = new Map<string, MonitorStateSnapshot>();
  const minuteResults = new Map<string, CompletedMinuteCheck>();
  const sender = createResendSender({
    apiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.RESEND_FROM_EMAIL ?? "",
  });
  return runMonitoringCoordinator({
    leases: createSqlLeaseStore(queryExecutor),
    runs: createSqlCronRunStore(queryExecutor),
    async loadConfig(now) {
      activeConfig = await loadAcceptedConfiguration(now);
      const states = await db.select().from(monitorState);
      stateSnapshots = new Map(states.map((state) => [state.monitorId, state]));
      return activeConfig;
    },
    reconcileOutbox: (now) => reconcileStaleClaims(queryExecutor, now),
    deliverOutbox: () => deliverPendingNotifications({
      db: queryExecutor,
      sender,
      appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
      log: (event) => console.info(JSON.stringify(event)),
    }),
    async runMonitor(monitor, _scheduledAt, runId) {
      if (!activeConfig) throw new Error("Accepted configuration is unavailable");
      const recipients = monitor.recipients.length > 0
        ? monitor.recipients
        : activeConfig.settings.defaultRecipients;
      const checkedAt = new Date();
      const result = await createHttpChecker({ userAgent: activeConfig.settings.userAgent })({
        url: monitor.url,
        method: monitor.method,
        timeoutMs: monitor.timeoutMs,
        expectedStatus: monitor.expectedStatus,
      });
      minuteResults.set(monitor.id, {
        monitorId: monitor.id,
        monitorName: monitor.name,
        checkedAt,
        successful: result.success,
        statusCode: result.statusCode,
        latencyMs: result.latencyMs,
        effectiveUrl: result.finalUrl,
        redirectCount: result.redirectCount,
        resolvedAddress: result.resolvedAddress,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        failureThreshold: monitor.failureThreshold,
        recoveryThreshold: monitor.recoveryThreshold,
        recipients,
      });
      console.info(JSON.stringify({
        event: "monitor.check.completed",
        runId,
        monitorId: monitor.id,
        status: result.success ? "success" : "failure",
        durationMs: result.latencyMs,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      }));
      return result.success ? "success" : "failure";
    },
    async persistMinute(config, scheduledMinute, schedulerStartedAt, schedulerCompletedAt) {
      const expectedMonitorIds = config.monitors
        .filter((monitor) => monitor.enabled && isDueAt(monitor, scheduledMinute))
        .map((monitor) => monitor.id);
      await persistAtomicMinute(queryExecutor, {
        scheduledMinute,
        configVersion: config.configVersion,
        monitorIds: config.monitors.filter((monitor) => monitor.enabled).map((monitor) => monitor.id),
        expectedMonitorIds,
        results: [...minuteResults.values()],
        states: stateSnapshots,
        schedulerStartedAt,
        schedulerCompletedAt,
      });
    },
  });
}
