import "server-only";

import { randomUUID } from "node:crypto";

import { createClient } from "@vercel/edge-config";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { createHttpChecker } from "@/lib/checker/checker";
import {
  evaluateConfigurationAcceptance,
  hashCanonical,
  validateMonitoringConfig,
  type MonitoringConfig,
} from "@/lib/config";
import { db, sql } from "@/lib/db/client";
import { portableQueryValues } from "@/lib/db/query-values";
import {
  configChangeApprovals,
  configOperations,
  monitoringConfigSnapshots,
  monitorState,
} from "@/lib/db/schema";
import type { MonitorStateSnapshot } from "@/lib/monitoring/types";
import { deliverPendingNotifications } from "@/lib/notifications/delivery";
import { ORDINARY_NOTIFICATION_EVENT_TYPES } from "@/lib/notifications/types";
import { createResendSender } from "@/lib/notifications/provider";
import { reconcileStaleClaims, type SqlExecutor } from "@/lib/notifications/sql";
import { persistAtomicMinute, type CompletedMinuteCheck } from "@/lib/storage/atomic-minute";
import { completesQuarterHourBucket, refreshRecentRollups } from "@/lib/storage/rollup-refresh";

import { requirePulseReleaseId } from "@/lib/release/id";

import { runMonitoringCoordinator } from "./coordinator";
import { evaluateConfigurationSource, requireApprovalConsumption } from "./configuration";
import { synchronizeRegistry as syncRegistryRows } from "./registry-sync";
import { createSqlCronRunStore, createSqlLeaseStore } from "./sql";
import { isDueAt } from "./time";

type AcceptedRow = {
  configJson: unknown;
  configHash: string;
};

export const queryExecutor: SqlExecutor & {
  withStatementTimeout<T>(
    timeoutMs: number,
    work: (query: <R>(text: string, values: readonly unknown[]) => Promise<readonly R[]>) => Promise<T>,
  ): Promise<T>;
} = {
  async query<T>(text: string, values: readonly unknown[]): Promise<readonly T[]> {
    return await sql.unsafe(text, portableQueryValues(values) as never[]) as unknown as readonly T[];
  },
  // One connection for the whole work block so SET LOCAL statement_timeout
  // applies to the maintenance SQL that follows inside the same transaction.
  async withStatementTimeout(timeoutMs, work) {
    return sql.begin(async (tx) => {
      const timeout = Math.max(1, Math.floor(timeoutMs));
      await tx.unsafe(
        `select set_config('statement_timeout', $1, true)`,
        [String(timeout)] as never[],
      );
      const query = async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        await tx.unsafe(text, portableQueryValues(values) as never[]) as unknown as readonly R[];
      return work(query);
    }) as Promise<ReturnType<typeof work>>;
  },
};

async function synchronizeRegistry(config: MonitoringConfig, hash: string, now: Date): Promise<void> {
  await db.transaction((tx) => syncRegistryRows(tx, config, hash, now, "runtime"));
}

async function loadAcceptedConfiguration(now: Date): Promise<MonitoringConfig> {
  const [last] = await db.select({
    configJson: monitoringConfigSnapshots.configJson,
    configHash: monitoringConfigSnapshots.configHash,
  }).from(monitoringConfigSnapshots)
    .where(eq(monitoringConfigSnapshots.status, "accepted"))
    .orderBy(desc(monitoringConfigSnapshots.acceptedAt), desc(monitoringConfigSnapshots.seenAt))
    .limit(1) as AcceptedRow[];
  const previous = last ? { config: validateMonitoringConfig(last.configJson), hash: last.configHash } : null;
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
    releaseId: requirePulseReleaseId(),
    async loadConfig(now) {
      activeConfig = await loadAcceptedConfiguration(now);
      const states = await db.select().from(monitorState);
      stateSnapshots = new Map(states.map((state) => [state.monitorId, state]));
      return activeConfig;
    },
    reconcileOutbox: (now) => reconcileStaleClaims(queryExecutor, now, undefined, {
      eventTypes: ORDINARY_NOTIFICATION_EVENT_TYPES,
    }),
    deliverOutbox: () => deliverPendingNotifications({
      db: queryExecutor,
      sender,
      appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
      log: (event) => console.info(JSON.stringify(event)),
    }, { eventTypes: ORDINARY_NOTIFICATION_EVENT_TYPES }),
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
        invalidatePublicStatus: async () => revalidatePath("/status", "layout"),
      });
      if (completesQuarterHourBucket(scheduledMinute)) {
        try {
          await refreshRecentRollups(queryExecutor, scheduledMinute, new Date());
        } catch (error) {
          // Rollups are display-only and self-heal on the next boundary or
          // during daily maintenance; never fail the check run over them.
          console.warn(JSON.stringify({
            event: "rollup.refresh.failed",
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    },
  });
}
