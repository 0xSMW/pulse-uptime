import "server-only"

import { createClient } from "@vercel/edge-config"
import { revalidatePath } from "next/cache"

import { createHttpChecker } from "@/lib/checker/checker"
import type { MonitoringConfig } from "@/lib/config"
import { db } from "@/lib/db/client"
import { queryExecutor } from "@/lib/db/query-executor"
import { monitorState } from "@/lib/db/schema"
import type { MonitorStateSnapshot } from "@/lib/monitoring/types"
import { deliverPendingNotifications } from "@/lib/notifications/delivery"
import { createResendSender } from "@/lib/notifications/provider"
import { reconcileStaleClaims } from "@/lib/notifications/sql"
import { ORDINARY_NOTIFICATION_EVENT_TYPES } from "@/lib/notifications/types"
import { requirePulseReleaseId } from "@/lib/release/id"
import {
  type CompletedMinuteCheck,
  persistAtomicMinute,
} from "@/lib/storage/atomic-minute"
import {
  completesQuarterHourBucket,
  refreshRecentRollups,
} from "@/lib/storage/rollup-refresh"
import { acceptDesiredConfiguration } from "./configuration-acceptance"
import { runMonitoringCoordinator } from "./coordinator"
import { createSqlCronRunStore, createSqlLeaseStore } from "./sql"
import { isDueAt } from "./time"

/**
 * Edge Config I/O stays outside the configuration lock so lock hold time
 * is only the DB critical section. Missing connection, transport failure, or
 * absent key fall through so acceptance evaluates the locked previous snapshot.
 */
async function readDesiredFromEdgeConfig(): Promise<unknown> {
  const connection = process.env.EDGE_CONFIG
  if (!connection) {
    return
  }
  try {
    return await createClient(connection).get("monitoring")
  } catch (error) {
    // Swallow Edge Config failures; locked evaluation uses previous snapshot.
    void error
  }
}

async function reconcileRuntimeConfiguration(
  now: Date
): Promise<MonitoringConfig> {
  const desired = await readDesiredFromEdgeConfig()
  return acceptDesiredConfiguration(desired, now)
}

export async function runMonitoringCron() {
  let activeConfig: MonitoringConfig | null = null
  let stateSnapshots = new Map<string, MonitorStateSnapshot>()
  const minuteResults = new Map<string, CompletedMinuteCheck>()
  const sender = createResendSender({
    apiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.RESEND_FROM_EMAIL ?? "",
  })
  return runMonitoringCoordinator({
    leases: createSqlLeaseStore(queryExecutor),
    runs: createSqlCronRunStore(queryExecutor),
    releaseId: requirePulseReleaseId(),
    async loadConfig(now) {
      activeConfig = await reconcileRuntimeConfiguration(now)
      const states = await db.select().from(monitorState)
      stateSnapshots = new Map(states.map((state) => [state.monitorId, state]))
      return activeConfig
    },
    reconcileOutbox: (now) =>
      reconcileStaleClaims(queryExecutor, now, undefined, {
        eventTypes: ORDINARY_NOTIFICATION_EVENT_TYPES,
      }),
    deliverOutbox: () =>
      deliverPendingNotifications(
        {
          db: queryExecutor,
          sender,
          appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
          log: (event) => console.info(JSON.stringify(event)),
        },
        { eventTypes: ORDINARY_NOTIFICATION_EVENT_TYPES }
      ),
    async runMonitor(monitor, _scheduledAt, runId) {
      if (!activeConfig) {
        throw new Error("Accepted configuration is unavailable")
      }
      const recipients =
        monitor.recipients.length > 0
          ? monitor.recipients
          : activeConfig.settings.defaultRecipients
      const checkedAt = new Date()
      const result = await createHttpChecker({
        userAgent: activeConfig.settings.userAgent,
      })({
        url: monitor.url,
        method: monitor.method,
        timeoutMs: monitor.timeoutMs,
        expectedStatus: monitor.expectedStatus,
      })
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
      })
      console.info(
        JSON.stringify({
          event: "monitor.check.completed",
          runId,
          monitorId: monitor.id,
          status: result.success ? "success" : "failure",
          durationMs: result.latencyMs,
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        })
      )
      return result.success ? "success" : "failure"
    },
    async persistMinute(
      config,
      scheduledMinute,
      schedulerStartedAt,
      schedulerCompletedAt
    ) {
      const expectedMonitorIds = config.monitors
        .filter(
          (monitor) => monitor.enabled && isDueAt(monitor, scheduledMinute)
        )
        .map((monitor) => monitor.id)
      await persistAtomicMinute(queryExecutor, {
        scheduledMinute,
        configVersion: config.configVersion,
        monitorIds: config.monitors
          .filter((monitor) => monitor.enabled)
          .map((monitor) => monitor.id),
        expectedMonitorIds,
        results: [...minuteResults.values()],
        states: stateSnapshots,
        schedulerStartedAt,
        schedulerCompletedAt,
        invalidatePublicStatus: async () => revalidatePath("/status", "layout"),
      })
      if (completesQuarterHourBucket(scheduledMinute)) {
        try {
          await refreshRecentRollups(queryExecutor, scheduledMinute, new Date())
        } catch (error) {
          // Rollups are display-only and self-heal on the next boundary or
          // during daily maintenance; never fail the check run over them.
          console.warn(
            JSON.stringify({
              event: "rollup.refresh.failed",
              error: error instanceof Error ? error.message : String(error),
            })
          )
        }
      }
    },
  })
}
