import { randomUUID } from "node:crypto";

import { MAINTENANCE_LEASE, withLease, type LeaseStore } from "@/lib/scheduler/lease";
import { emptyRunCounts, safeCronError, type CronRunStore } from "@/lib/scheduler/run-record";
import { scheduledMinuteAt, utcDay } from "@/lib/scheduler/time";

export interface MaintenanceStore {
  reconcileStaleOutbox(now: Date): Promise<number>;
  reconcileStaleCronRuns(now: Date): Promise<number>;
  upsertDailyRollup(day: string, now: Date): Promise<number>;
  deleteRawChecks(cutoff: Date, limit: number): Promise<number>;
  deleteSentNotifications(cutoff: Date, limit: number): Promise<number>;
  expireConfigApprovals(now: Date, consumedCutoff: Date, limit: number): Promise<number>;
  expireApiIdempotency(now: Date, limit: number): Promise<number>;
  markDeviceAuthorizationsExpired(now: Date, limit: number): Promise<number>;
  deleteExpiredDeviceAuthorizations(retentionCutoff: Date, limit: number): Promise<number>;
  expireRateLimitBuckets(now: Date, limit: number): Promise<number>;
  retainConfigSnapshots(rejectedCutoff: Date, acceptedLimit: number, limit: number): Promise<number>;
  deleteOldCronRuns(cutoff: Date, limit: number): Promise<number>;
  deleteOldRollups(dayCutoff: string, limit: number): Promise<number>;
}

export type MaintenanceSummary = {
  staleOutbox: number;
  staleCronRuns: number;
  rollups: number;
  deleted: number;
  expired: number;
};

export const RETENTION_BATCH_SIZE = 10_000;
export const MAINTENANCE_WORK_BUDGET_MS = 45_000;

async function drainBatches(
  operation: (limit: number) => Promise<number>,
  nowMs: () => number,
  deadlineAtMs: number,
): Promise<number> {
  let total = 0;
  while (nowMs() < deadlineAtMs) {
    const affected = await operation(RETENTION_BATCH_SIZE);
    total += affected;
    if (affected < RETENTION_BATCH_SIZE) break;
  }
  return total;
}

export async function performMaintenance(
  store: MaintenanceStore,
  now: Date,
  options: { nowMs?: () => number; deadlineAtMs?: number } = {},
): Promise<MaintenanceSummary> {
  const nowMs = options.nowMs ?? Date.now;
  const deadlineAtMs = options.deadlineAtMs ?? nowMs() + MAINTENANCE_WORK_BUDGET_MS;
  const dayOne = utcDay(now, 1);
  const dayTwo = utcDay(now, 2);
  const rawCutoff = new Date(now.getTime() - 30 * 86_400_000);
  const sentCutoff = new Date(now.getTime() - 90 * 86_400_000);
  const shortCutoff = new Date(now.getTime() - 7 * 86_400_000);
  const consumedApprovalCutoff = new Date(now.getTime() - 30 * 86_400_000);
  const cronCutoff = new Date(now.getTime() - 90 * 86_400_000);
  const rejectedCutoff = new Date(now.getTime() - 30 * 86_400_000);
  const rollupCutoff = utcDay(now, 365);

  const staleOutbox = await store.reconcileStaleOutbox(now);
  const staleCronRuns = await store.reconcileStaleCronRuns(now);
  const rollups = await store.upsertDailyRollup(dayOne, now) + await store.upsertDailyRollup(dayTwo, now);
  const deleted =
    await drainBatches((limit) => store.deleteRawChecks(rawCutoff, limit), nowMs, deadlineAtMs) +
    await drainBatches((limit) => store.deleteSentNotifications(sentCutoff, limit), nowMs, deadlineAtMs) +
    await drainBatches((limit) => store.retainConfigSnapshots(rejectedCutoff, 50, limit), nowMs, deadlineAtMs) +
    await drainBatches((limit) => store.deleteOldCronRuns(cronCutoff, limit), nowMs, deadlineAtMs) +
    await drainBatches((limit) => store.deleteOldRollups(rollupCutoff, limit), nowMs, deadlineAtMs);
  const expired =
    await drainBatches((limit) => store.expireConfigApprovals(now, consumedApprovalCutoff, limit), nowMs, deadlineAtMs) +
    await drainBatches((limit) => store.expireApiIdempotency(now, limit), nowMs, deadlineAtMs) +
    await drainBatches((limit) => store.markDeviceAuthorizationsExpired(now, limit), nowMs, deadlineAtMs) +
    await drainBatches((limit) => store.deleteExpiredDeviceAuthorizations(shortCutoff, limit), nowMs, deadlineAtMs) +
    await drainBatches((limit) => store.expireRateLimitBuckets(now, limit), nowMs, deadlineAtMs);
  return { staleOutbox, staleCronRuns, rollups, deleted, expired };
}

export async function runMaintenanceCoordinator(dependencies: {
  leases: LeaseStore;
  runs: CronRunStore;
  store: MaintenanceStore;
  now?: () => Date;
  createId?: () => string;
}): Promise<
  | { status: "lease-held" }
  | { status: "duplicate"; runId: string }
  | { status: "completed"; runId: string; summary: MaintenanceSummary }
  | { status: "failed"; runId: string; error: string }
> {
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const startedAt = now();
  const runId = createId();
  const ownerId = createId();
  const result = await withLease(dependencies.leases, MAINTENANCE_LEASE, ownerId, startedAt, async () => {
    if (!await dependencies.runs.start({
      id: runId,
      jobName: "maintenance",
      scheduledMinute: scheduledMinuteAt(startedAt),
      startedAt,
    })) return { status: "duplicate", runId } as const;
    try {
      const summary = await performMaintenance(dependencies.store, startedAt);
      await dependencies.runs.complete(runId, now(), emptyRunCounts());
      return { status: "completed", runId, summary } as const;
    } catch (error) {
      const safeError = safeCronError(error);
      await dependencies.runs.fail(runId, now(), safeError);
      return { status: "failed", runId, error: safeError } as const;
    }
  });
  return result.acquired ? result.value : { status: "lease-held" };
}
