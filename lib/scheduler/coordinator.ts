import { randomUUID } from "node:crypto";

import type { MonitoringConfig, MonitorConfig } from "@/lib/config/schema";
import type { DeliverySummary } from "@/lib/notifications/delivery";

import { dispatchDueMonitors, type MonitorRunOutcome } from "./dispatch";
import { MONITORING_LEASE, withLease, type LeaseStore } from "./lease";
import { emptyRunCounts, safeCronError, type CronRunCounts, type CronRunStore } from "./run-record";
import { scheduledMinuteAt } from "./time";

export type MonitoringCoordinatorDependencies = {
  leases: LeaseStore;
  runs: CronRunStore;
  loadConfig(now: Date): Promise<MonitoringConfig>;
  reconcileOutbox(now: Date): Promise<number>;
  deliverOutbox(): Promise<DeliverySummary>;
  runMonitor(monitor: MonitorConfig, scheduledAt: Date, runId: string): Promise<MonitorRunOutcome>;
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
      await dependencies.deliverOutbox();
      await dependencies.runs.complete(runId, now(), counts);
      return { status: "completed", runId, counts, staleClaims } as const;
    } catch (error) {
      const safeError = safeCronError(error);
      await dependencies.runs.fail(runId, now(), safeError, emptyRunCounts());
      return { status: "failed", runId, error: safeError } as const;
    }
  });
  return leased.acquired ? leased.value : { status: "lease-held" };
}
