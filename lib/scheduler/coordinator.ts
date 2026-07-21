import type { MonitorConfig, MonitoringConfig } from "@/lib/config/schema"
import type { DeliverySummary } from "@/lib/notifications/delivery"

import { runCronCoordinator } from "./cron-coordinator"
import { dispatchDueMonitors, type MonitorRunOutcome } from "./dispatch"
import { type LeaseStore, MONITORING_LEASE } from "./lease"
import type { CronRunCounts, CronRunStore } from "./run-record"

export interface MonitoringCoordinatorDependencies {
  leases: LeaseStore
  runs: CronRunStore
  // Deployment identity recorded on the cron_runs row for release-bound proof.
  releaseId: string
  loadConfig: (now: Date) => Promise<MonitoringConfig>
  reconcileOutbox: (now: Date) => Promise<number>
  deliverOutbox: () => Promise<DeliverySummary>
  runMonitor: (
    monitor: MonitorConfig,
    scheduledAt: Date,
    runId: string
  ) => Promise<MonitorRunOutcome>
  persistMinute?: (
    config: MonitoringConfig,
    scheduledMinute: Date,
    schedulerStartedAt: Date,
    schedulerCompletedAt: Date
  ) => Promise<void>
  now?: () => Date
  nowMs?: () => number
  createId?: () => string
}

export type MonitoringRunResult =
  | { status: "lease-held" }
  | { status: "duplicate"; runId: string }
  | {
      status: "completed"
      runId: string
      counts: CronRunCounts
      staleClaims: number
    }
  | { status: "failed"; runId: string; error: string }

export async function runMonitoringCoordinator(
  dependencies: MonitoringCoordinatorDependencies
): Promise<MonitoringRunResult> {
  const now = dependencies.now ?? (() => new Date())
  const nowMs = dependencies.nowMs ?? Date.now
  const invocationStartedAtMs = nowMs()

  return runCronCoordinator(
    {
      leases: dependencies.leases,
      runs: dependencies.runs,
      leaseName: MONITORING_LEASE,
      jobName: "monitor-check",
      releaseId: dependencies.releaseId,
      now: dependencies.now,
      createId: dependencies.createId,
    },
    async ({ runId, startedAt, scheduledMinute, progress }) => {
      const config = await dependencies.loadConfig(startedAt)
      const staleClaims = await dependencies.reconcileOutbox(startedAt)
      await dependencies.deliverOutbox()
      const counts = await dispatchDueMonitors({
        monitors: config.monitors,
        scheduledAt: scheduledMinute,
        invocationStartedAtMs,
        nowMs,
        concurrency: config.settings.concurrency,
        run: (monitor, scheduledAt) =>
          dependencies.runMonitor(monitor, scheduledAt, runId),
      })
      // Record before minute persistence / final delivery so a late failure
      // still persists real dispatch counts instead of zeros.
      progress.record(counts)
      if (dependencies.persistMinute) {
        await dependencies.persistMinute(
          config,
          scheduledMinute,
          startedAt,
          now()
        )
      }
      await dependencies.deliverOutbox()
      return { counts, staleClaims }
    }
  )
}
