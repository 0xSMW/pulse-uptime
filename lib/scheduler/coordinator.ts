import { randomUUID } from "node:crypto";

import type { MonitoringConfig, MonitorConfig } from "@/lib/config/schema";
import type { DeliverySummary } from "@/lib/notifications/delivery";

import { dispatchDueMonitors, type MonitorRunOutcome } from "./dispatch";
import { MONITORING_LEASE, withLease, type LeaseStore } from "./lease";
import { emptyRunCounts, toCronRunFailure, type CronRunCounts, type CronRunStore } from "./run-record";
import { scheduledMinuteAt } from "./time";

export type MonitoringCoordinatorDependencies = {
  leases: LeaseStore;
  runs: CronRunStore;
  // Deployment identity recorded on the cron_runs row for release-bound proof.
  releaseId: string;
  loadConfig(now: Date): Promise<MonitoringConfig>;
  reconcileOutbox(now: Date): Promise<number>;
  deliverOutbox(): Promise<DeliverySummary>;
  runMonitor(monitor: MonitorConfig, scheduledAt: Date, runId: string): Promise<MonitorRunOutcome>;
  persistMinute?(
    config: MonitoringConfig,
    scheduledMinute: Date,
    schedulerStartedAt: Date,
    schedulerCompletedAt: Date,
  ): Promise<void>;
  now?: () => Date;
  nowMs?: () => number;
  createId?: () => string;
};

export type MonitoringRunResult =
  | { status: "lease-held" }
  | { status: "duplicate"; runId: string }
  | { status: "completed"; runId: string; counts: CronRunCounts; staleClaims: number }
  | { status: "failed"; runId: string; error: string };

export async function runMonitoringCoordinator(
  dependencies: MonitoringCoordinatorDependencies,
): Promise<MonitoringRunResult> {
  const now = dependencies.now ?? (() => new Date());
  const nowMs = dependencies.nowMs ?? Date.now;
  const createId = dependencies.createId ?? randomUUID;
  const startedAt = now();
  const invocationStartedAtMs = nowMs();
  const scheduledMinute = scheduledMinuteAt(startedAt);
  const ownerId = createId();
  const runId = createId();

  const leased = await withLease(dependencies.leases, MONITORING_LEASE, ownerId, startedAt, async () => {
    if (!await dependencies.runs.start({
      id: runId,
      jobName: "monitor-check",
      scheduledMinute,
      startedAt,
      releaseId: dependencies.releaseId,
    })) return { status: "duplicate", runId } as const;

    try {
      const config = await dependencies.loadConfig(startedAt);
      const staleClaims = await dependencies.reconcileOutbox(startedAt);
      await dependencies.deliverOutbox();
      const counts = await dispatchDueMonitors({
        monitors: config.monitors,
        scheduledAt: scheduledMinute,
        invocationStartedAtMs,
        nowMs,
        concurrency: config.settings.concurrency,
        run: (monitor, scheduledAt) => dependencies.runMonitor(monitor, scheduledAt, runId),
      });
      if (dependencies.persistMinute) {
        await dependencies.persistMinute(config, scheduledMinute, startedAt, now());
      }
      await dependencies.deliverOutbox();
      await dependencies.runs.complete(runId, now(), counts);
      return { status: "completed", runId, counts, staleClaims } as const;
    } catch (error) {
      const failure = toCronRunFailure(error);
      await dependencies.runs.fail(runId, now(), failure, emptyRunCounts());
      return { status: "failed", runId, error: failure.message } as const;
    }
  });
  return leased.acquired ? leased.value : { status: "lease-held" };
}
