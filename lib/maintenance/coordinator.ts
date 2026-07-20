import { randomUUID } from "node:crypto";

import { MAINTENANCE_LEASE, withLease, type LeaseStore } from "@/lib/scheduler/lease";
import { emptyRunCounts, toCronRunFailure, type CronRunStore } from "@/lib/scheduler/run-record";
import { scheduledMinuteAt, utcDay } from "@/lib/scheduler/time";
import type { GovernorMode } from "@/lib/storage/governor";

export interface MaintenanceStore {
  reconcileStaleOutbox(now: Date): Promise<number>;
  reconcileStaleCronRuns(now: Date): Promise<number>;
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
  compact15Minute(start: Date, end: Date, now: Date): Promise<number>;
  fillSchedulerGaps(start: Date, end: Date, now: Date): Promise<number>;
  schedulerCoverageStart(now: Date): Promise<Date>;
  promoteRollups(source: "15m" | "hour", target: "hour" | "day", start: Date, end: Date): Promise<number>;
  measureAndSnapshotUsage(now: Date): Promise<GovernorMode>;
  enforceTelemetryRetention(now: Date, mode: GovernorMode, limit: number): Promise<number>;
  retainUsageSnapshots(now: Date, limit: number): Promise<number>;
  retainExceptions(now: Date, limit: number): Promise<number>;
  retainExceptionPayloads(now: Date, limit: number): Promise<number>;
  /** Orphan images: unattached for 24h, plus a hard cap keeping the newest N. */
  deleteOrphanImages(cutoff: Date, keepNewest: number, limit: number): Promise<number>;
  /** Fetches every enabled dependency source once (read-only, live) and disables only the presets whose selector ids have drifted. Runs once per maintenance pass inside a reserved slice, stopping at deadlineAtMs so it cannot overrun the maintenance window. */
  reconcileDependencyCatalog(now: Date, deadlineAtMs?: number): Promise<{ checkedSources: number; disabledPresets: number }>;
  /** Empties provider_incident_updates body text older than two years. Incident identity and timing outlive this. */
  retainDependencyIncidentUpdates(cutoff: Date, limit: number): Promise<number>;
  /** Closed dependency_state_intervals older than two years, compacted to one row per dependency/day/state. */
  compactDependencyStateIntervals(cutoff: Date, limit: number): Promise<number>;
}

export type MaintenanceSummary = {
  staleOutbox: number;
  staleCronRuns: number;
  rollups: number;
  deleted: number;
  expired: number;
  governorMode: GovernorMode;
  dependencyCatalog: { checkedSources: number; disabledPresets: number };
};

export const RETENTION_BATCH_SIZE = 10_000;
export const MAINTENANCE_WORK_BUDGET_MS = 45_000;
// Catalog validation gets this slice reserved from the maintenance window. The
// reservation means heavy retention can never starve it, and its own deadline
// caps it to the slice so it can never overrun the window or starve retention.
export const CATALOG_VALIDATION_BUDGET_MS = 10_000;
export const ORPHAN_IMAGE_KEEP_NEWEST = 20;
export const SWEEP_WORK_BUDGET_MS = 20_000;

export type SweepSummary = { expired: number };

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
  // Gap recovery and retention stop this far before the window ends, reserving
  // the tail slice for catalog validation so a heavy night can never starve it.
  const retentionDeadlineAtMs = deadlineAtMs - CATALOG_VALIDATION_BUDGET_MS;
  const rawCutoff = new Date(now.getTime() - 30 * 86_400_000);
  const sentCutoff = new Date(now.getTime() - 90 * 86_400_000);
  const shortCutoff = new Date(now.getTime() - 7 * 86_400_000);
  const consumedApprovalCutoff = new Date(now.getTime() - 30 * 86_400_000);
  const cronCutoff = new Date(now.getTime() - 90 * 86_400_000);
  const rejectedCutoff = new Date(now.getTime() - 30 * 86_400_000);
  const rollupCutoff = utcDay(now, 365);
  const recentCompactStart = new Date(now.getTime() - 48 * 3_600_000);
  const orphanImageCutoff = new Date(now.getTime() - 24 * 3_600_000);
  const dependencyRetentionCutoff = new Date(now.getTime() - 730 * 86_400_000);

  const staleOutbox = await store.reconcileStaleOutbox(now);
  const staleCronRuns = await store.reconcileStaleCronRuns(now);
  let rollups = 0;
  let coverageCursor = await store.schedulerCoverageStart(now);
  while (coverageCursor < now && nowMs() < retentionDeadlineAtMs) {
    const chunkEnd = new Date(Math.min(now.getTime(), coverageCursor.getTime() + 86_400_000));
    await store.fillSchedulerGaps(coverageCursor, chunkEnd, now);
    rollups += await store.compact15Minute(coverageCursor, chunkEnd, now)
      + await store.promoteRollups("15m", "hour", coverageCursor, chunkEnd)
      + await store.promoteRollups("hour", "day", coverageCursor, chunkEnd);
    coverageCursor = chunkEnd;
  }
  rollups += await store.compact15Minute(recentCompactStart, now, now)
    + await store.promoteRollups("15m", "hour", recentCompactStart, now)
    + await store.promoteRollups("hour", "day", recentCompactStart, now);
  const governorMode = await store.measureAndSnapshotUsage(now);
  const deleted =
    await drainBatches((limit) => store.enforceTelemetryRetention(now, governorMode, limit), nowMs, retentionDeadlineAtMs) +
    await drainBatches((limit) => store.retainUsageSnapshots(now, limit), nowMs, retentionDeadlineAtMs) +
    await drainBatches((limit) => store.retainExceptions(now, limit), nowMs, retentionDeadlineAtMs) +
    await drainBatches((limit) => store.retainExceptionPayloads(now, limit), nowMs, retentionDeadlineAtMs) +
    await drainBatches((limit) => store.deleteRawChecks(rawCutoff, limit), nowMs, retentionDeadlineAtMs) +
    await drainBatches((limit) => store.deleteSentNotifications(sentCutoff, limit), nowMs, retentionDeadlineAtMs) +
    await drainBatches((limit) => store.retainConfigSnapshots(rejectedCutoff, 50, limit), nowMs, retentionDeadlineAtMs) +
    await drainBatches((limit) => store.deleteOldCronRuns(cronCutoff, limit), nowMs, retentionDeadlineAtMs) +
    await drainBatches((limit) => store.deleteOldRollups(rollupCutoff, limit), nowMs, retentionDeadlineAtMs) +
    await drainBatches((limit) => store.deleteOrphanImages(orphanImageCutoff, ORPHAN_IMAGE_KEEP_NEWEST, limit), nowMs, retentionDeadlineAtMs) +
    await drainBatches((limit) => store.retainDependencyIncidentUpdates(dependencyRetentionCutoff, limit), nowMs, retentionDeadlineAtMs) +
    await drainBatches((limit) => store.compactDependencyStateIntervals(dependencyRetentionCutoff, limit), nowMs, retentionDeadlineAtMs);
  const expired =
    await drainBatches((limit) => store.expireConfigApprovals(now, consumedApprovalCutoff, limit), nowMs, retentionDeadlineAtMs) +
    await drainBatches((limit) => store.expireApiIdempotency(now, limit), nowMs, retentionDeadlineAtMs) +
    await drainBatches((limit) => store.markDeviceAuthorizationsExpired(now, limit), nowMs, retentionDeadlineAtMs) +
    await drainBatches((limit) => store.deleteExpiredDeviceAuthorizations(shortCutoff, limit), nowMs, retentionDeadlineAtMs) +
    await drainBatches((limit) => store.expireRateLimitBuckets(now, limit), nowMs, retentionDeadlineAtMs);
  // Dependency catalog reconciliation makes live, sequential multi-source http
  // fetches and is a daily-cadence drift check. It runs last inside the slice
  // reserved above, bounded in both directions. Retention drains stop at the
  // reserved boundary, so heavy retention can never starve reconciliation, and
  // reconciliation runs against its own deadline one slice wide, so it can never
  // overrun the maintenance window or starve retention. It is skipped only when
  // earlier work already spent the whole window, and a skipped pass reports zero
  // checked sources so the summary stays truthful.
  const catalogStartMs = nowMs();
  const catalogDeadlineAtMs = Math.min(deadlineAtMs, catalogStartMs + CATALOG_VALIDATION_BUDGET_MS);
  const dependencyCatalog = catalogStartMs < deadlineAtMs
    ? await store.reconcileDependencyCatalog(now, catalogDeadlineAtMs)
    : { checkedSources: 0, disabledPresets: 0 };
  return { staleOutbox, staleCronRuns, rollups, deleted, expired, governorMode, dependencyCatalog };
}

/**
 * Frequent, low-cost sweep of short-lived rows (rate-limit buckets, idempotency keys,
 * device authorizations, expired config approvals). These grow fastest and their
 * cleanup would otherwise queue behind heavy daily telemetry retention. The operations
 * are idempotent deletes, so this needs no lease: a concurrent double-run only re-deletes
 * already-expired rows.
 */
export async function performSweep(
  store: MaintenanceStore,
  now: Date,
  options: { nowMs?: () => number; deadlineAtMs?: number } = {},
): Promise<SweepSummary> {
  const nowMs = options.nowMs ?? Date.now;
  const deadlineAtMs = options.deadlineAtMs ?? nowMs() + SWEEP_WORK_BUDGET_MS;
  const shortCutoff = new Date(now.getTime() - 7 * 86_400_000);
  const consumedApprovalCutoff = new Date(now.getTime() - 30 * 86_400_000);
  const expired =
    await drainBatches((limit) => store.expireRateLimitBuckets(now, limit), nowMs, deadlineAtMs) +
    await drainBatches((limit) => store.expireApiIdempotency(now, limit), nowMs, deadlineAtMs) +
    await drainBatches((limit) => store.markDeviceAuthorizationsExpired(now, limit), nowMs, deadlineAtMs) +
    await drainBatches((limit) => store.deleteExpiredDeviceAuthorizations(shortCutoff, limit), nowMs, deadlineAtMs) +
    await drainBatches((limit) => store.expireConfigApprovals(now, consumedApprovalCutoff, limit), nowMs, deadlineAtMs);
  return { expired };
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
      const failure = toCronRunFailure(error);
      await dependencies.runs.fail(runId, now(), failure);
      return { status: "failed", runId, error: failure.message } as const;
    }
  });
  return result.acquired ? result.value : { status: "lease-held" };
}
