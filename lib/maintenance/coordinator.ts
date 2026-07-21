import { randomUUID } from "node:crypto"

import {
  type LeaseStore,
  MAINTENANCE_LEASE,
  withLease,
} from "@/lib/scheduler/lease"
import {
  type CronRunStore,
  emptyRunCounts,
  toCronRunFailure,
} from "@/lib/scheduler/run-record"
import { scheduledMinuteAt, utcDay } from "@/lib/scheduler/time"
import type { GovernorMode } from "@/lib/storage/governor"

import {
  createMaintenanceBudget,
  type MaintenanceBudget,
  type MaintenanceSkippedTask,
  MIN_CATALOG_TASK_MS,
  MIN_MAINTENANCE_TASK_MS,
  MIN_RETENTION_BATCH_MS,
  MIN_USAGE_MEASUREMENT_MS,
} from "./budget"

export interface MaintenanceStore {
  reconcileStaleOutbox: (now: Date, remainingMs?: number) => Promise<number>
  reconcileStaleCronRuns: (now: Date, remainingMs?: number) => Promise<number>
  deleteRawChecks: (
    cutoff: Date,
    limit: number,
    remainingMs?: number
  ) => Promise<number>
  deleteSentNotifications: (
    cutoff: Date,
    limit: number,
    remainingMs?: number
  ) => Promise<number>
  expireConfigApprovals: (
    now: Date,
    consumedCutoff: Date,
    limit: number,
    remainingMs?: number
  ) => Promise<number>
  expireApiIdempotency: (
    now: Date,
    limit: number,
    remainingMs?: number
  ) => Promise<number>
  markDeviceAuthorizationsExpired: (
    now: Date,
    limit: number,
    remainingMs?: number
  ) => Promise<number>
  deleteExpiredDeviceAuthorizations: (
    retentionCutoff: Date,
    limit: number,
    remainingMs?: number
  ) => Promise<number>
  expireRateLimitBuckets: (
    now: Date,
    limit: number,
    remainingMs?: number
  ) => Promise<number>
  retainConfigSnapshots: (
    rejectedCutoff: Date,
    acceptedLimit: number,
    limit: number,
    remainingMs?: number
  ) => Promise<number>
  deleteOldCronRuns: (
    cutoff: Date,
    limit: number,
    remainingMs?: number
  ) => Promise<number>
  deleteOldRollups: (
    dayCutoff: string,
    limit: number,
    remainingMs?: number
  ) => Promise<number>
  compact15Minute: (
    start: Date,
    end: Date,
    now: Date,
    remainingMs?: number
  ) => Promise<number>
  fillSchedulerGaps: (
    start: Date,
    end: Date,
    now: Date,
    remainingMs?: number
  ) => Promise<number>
  schedulerCoverageStart: (now: Date, remainingMs?: number) => Promise<Date>
  promoteRollups: (
    source: "15m" | "hour",
    target: "hour" | "day",
    start: Date,
    end: Date,
    remainingMs?: number
  ) => Promise<number>
  measureAndSnapshotUsage: (
    now: Date,
    remainingMs?: number
  ) => Promise<GovernorMode>
  /** Latest stored governor mode when measurement cannot run this pass. */
  readLatestGovernorMode: () => Promise<GovernorMode | null>
  enforceTelemetryRetention: (
    now: Date,
    mode: GovernorMode,
    limit: number,
    remainingMs?: number
  ) => Promise<number>
  retainUsageSnapshots: (
    now: Date,
    limit: number,
    remainingMs?: number
  ) => Promise<number>
  retainExceptions: (
    now: Date,
    limit: number,
    remainingMs?: number
  ) => Promise<number>
  retainExceptionPayloads: (
    now: Date,
    limit: number,
    remainingMs?: number
  ) => Promise<number>
  /** Orphan images: unattached for 24h, plus a hard cap keeping the newest N. */
  deleteOrphanImages: (
    cutoff: Date,
    keepNewest: number,
    limit: number,
    remainingMs?: number
  ) => Promise<number>
  /** Fetches every enabled dependency source once (read-only, live) and disables only the presets whose selector ids have drifted. Runs once per maintenance pass inside a reserved slice, stopping at deadlineAtMs so it cannot overrun the maintenance window. */
  reconcileDependencyCatalog: (
    now: Date,
    deadlineAtMs?: number
  ) => Promise<{ checkedSources: number; disabledPresets: number }>
  /** Empties provider_incident_updates body text older than two years. Incident identity and timing outlive this. */
  retainDependencyIncidentUpdates: (
    cutoff: Date,
    limit: number,
    remainingMs?: number
  ) => Promise<number>
  /** Closed dependency_state_intervals older than two years, compacted to one row per dependency/day/state. */
  compactDependencyStateIntervals: (
    cutoff: Date,
    limit: number,
    remainingMs?: number
  ) => Promise<number>
}

export interface MaintenanceSummary {
  staleOutbox: number
  staleCronRuns: number
  rollups: number
  deleted: number
  expired: number
  governorMode: GovernorMode
  dependencyCatalog: { checkedSources: number; disabledPresets: number }
  skippedTasks: MaintenanceSkippedTask[]
  deadlineExceeded: boolean
}

const RETENTION_BATCH_SIZE = 10_000
const MAINTENANCE_WORK_BUDGET_MS = 45_000
// Catalog validation gets this slice reserved from the maintenance window. The
// reservation means heavy retention can never starve it, and its own deadline
// caps it to the slice so it can never overrun the window or starve retention.
export const CATALOG_VALIDATION_BUDGET_MS = 10_000
const ORPHAN_IMAGE_KEEP_NEWEST = 20
const SWEEP_WORK_BUDGET_MS = 20_000

export interface SweepSummary {
  /** Sum of all short-lived row expirations this pass. */
  expired: number
  /** Per-category counts. Aggregate `expired` remains the stable contract. */
  categories: {
    rateLimit: number
    apiIdempotency: number
    deviceMark: number
    deviceDelete: number
    configApprovals: number
  }
}

/**
 * True when a store step was cancelled by the budgeted statement_timeout.
 * Pre-catalog work treats this as a soft skip so the reserved catalog slice
 * still runs. Real database failures continue to throw.
 */
export function isStatementBudgetError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false
  }
  const code =
    "code" in error ? String((error as { code?: unknown }).code ?? "") : ""
  if (code === "57014") {
    return true
  }
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase()
  return (
    message.includes("statement timeout") ||
    message.includes("canceling statement") ||
    message.includes("query_canceled")
  )
}

/**
 * Runs one budget-guarded maintenance step. When the bound has insufficient
 * remaining time, records a skip and returns fallback without starting work.
 * Pre-catalog statement timeouts also soft-skip so catalog reconciliation is
 * not starved by a late retention cancel.
 */
async function runGuarded<T>(
  budget: MaintenanceBudget,
  task: string,
  bound: "hard" | "pre_catalog" | "catalog",
  minimumMs: number,
  fallback: T,
  work: (remainingMs: number) => Promise<T>
): Promise<T> {
  if (!budget.canStart(minimumMs, bound)) {
    const reason =
      bound === "hard" || bound === "catalog"
        ? ("hard_deadline" as const)
        : ("pre_catalog_budget" as const)
    // Catalog-bound skips use catalog_budget when the hard window still has
    // room but the catalog slice itself is spent (rare: catalog bound equals
    // hard, so this is mainly pre_catalog).
    budget.recordSkip(
      task,
      bound === "catalog" && budget.remainingMs("hard") > 0
        ? "catalog_budget"
        : reason
    )
    return fallback
  }
  try {
    return await work(budget.remainingMs(bound))
  } catch (error) {
    if (bound === "pre_catalog" && isStatementBudgetError(error)) {
      budget.recordSkip(task, "pre_catalog_budget")
      return fallback
    }
    throw error
  }
}

async function drainBatches(
  task: string,
  operation: (limit: number, remainingMs: number) => Promise<number>,
  budget: MaintenanceBudget
): Promise<number> {
  if (!budget.canStart(MIN_RETENTION_BATCH_MS, "pre_catalog")) {
    budget.recordSkip(task, "pre_catalog_budget")
    return 0
  }
  let total = 0
  while (budget.canStart(MIN_RETENTION_BATCH_MS, "pre_catalog")) {
    try {
      const affected = await operation(
        RETENTION_BATCH_SIZE,
        budget.remainingMs("pre_catalog")
      )
      total += affected
      if (affected < RETENTION_BATCH_SIZE) {
        break
      }
    } catch (error) {
      if (isStatementBudgetError(error)) {
        budget.recordSkip(task, "pre_catalog_budget")
        break
      }
      throw error
    }
  }
  return total
}

export async function performMaintenance(
  store: MaintenanceStore,
  now: Date,
  options: { nowMs?: () => number; deadlineAtMs?: number } = {}
): Promise<MaintenanceSummary> {
  const nowMs = options.nowMs ?? Date.now
  const hardDeadlineAtMs =
    options.deadlineAtMs ?? nowMs() + MAINTENANCE_WORK_BUDGET_MS
  const budget = createMaintenanceBudget({
    nowMs,
    hardDeadlineAtMs,
    catalogBudgetMs: CATALOG_VALIDATION_BUDGET_MS,
  })

  const rawCutoff = new Date(now.getTime() - 30 * 86_400_000)
  const sentCutoff = new Date(now.getTime() - 90 * 86_400_000)
  const shortCutoff = new Date(now.getTime() - 7 * 86_400_000)
  const consumedApprovalCutoff = new Date(now.getTime() - 30 * 86_400_000)
  const cronCutoff = new Date(now.getTime() - 90 * 86_400_000)
  const rejectedCutoff = new Date(now.getTime() - 30 * 86_400_000)
  const rollupCutoff = utcDay(now, 365)
  const recentCompactStart = new Date(now.getTime() - 48 * 3_600_000)
  const orphanImageCutoff = new Date(now.getTime() - 24 * 3_600_000)
  const dependencyRetentionCutoff = new Date(now.getTime() - 730 * 86_400_000)

  // 1. Early hard-deadline work: stale outbox + stale cron reconciliation.
  const staleOutbox = await runGuarded(
    budget,
    "stale_outbox",
    "hard",
    MIN_MAINTENANCE_TASK_MS,
    0,
    (remainingMs) => store.reconcileStaleOutbox(now, remainingMs)
  )
  const staleCronRuns = await runGuarded(
    budget,
    "stale_cron",
    "hard",
    MIN_MAINTENANCE_TASK_MS,
    0,
    (remainingMs) => store.reconcileStaleCronRuns(now, remainingMs)
  )

  // 2. Early pre-catalog: usage measurement + governor decision, before long
  // gap recovery. When measurement cannot run, report the latest stored mode.
  let governorMode: GovernorMode
  if (budget.canStart(MIN_USAGE_MEASUREMENT_MS, "pre_catalog")) {
    try {
      governorMode = await store.measureAndSnapshotUsage(
        now,
        budget.remainingMs("pre_catalog")
      )
    } catch (error) {
      if (!isStatementBudgetError(error)) {
        throw error
      }
      budget.recordSkip("usage_measurement", "pre_catalog_budget")
      governorMode = (await store.readLatestGovernorMode()) ?? "essential"
    }
  } else {
    budget.recordSkip("usage_measurement", "pre_catalog_budget")
    governorMode = (await store.readLatestGovernorMode()) ?? "essential"
  }

  let rollups = 0

  // 3. Middle pre-catalog: scheduler-gap recovery in daily chunks. Each fill,
  // compact, and promotion is its own guarded step so a spent pre-catalog
  // bound cannot start the next chunk mid-recovery.
  let cursor = now
  if (budget.canStart(MIN_MAINTENANCE_TASK_MS, "pre_catalog")) {
    try {
      cursor = await store.schedulerCoverageStart(
        now,
        budget.remainingMs("pre_catalog")
      )
    } catch (error) {
      if (!isStatementBudgetError(error)) {
        throw error
      }
      budget.recordSkip("scheduler_coverage_start", "pre_catalog_budget")
    }
  } else {
    budget.recordSkip("scheduler_coverage_start", "pre_catalog_budget")
  }
  while (cursor < now) {
    if (!budget.canStart(MIN_MAINTENANCE_TASK_MS, "pre_catalog")) {
      budget.recordSkip("scheduler_gap_recovery", "pre_catalog_budget")
      break
    }
    const chunkEnd = new Date(
      Math.min(now.getTime(), cursor.getTime() + 86_400_000)
    )
    try {
      await store.fillSchedulerGaps(
        cursor,
        chunkEnd,
        now,
        budget.remainingMs("pre_catalog")
      )
    } catch (error) {
      if (!isStatementBudgetError(error)) {
        throw error
      }
      budget.recordSkip("scheduler_gap_recovery", "pre_catalog_budget")
      break
    }

    const compactChunk = await runGuarded(
      budget,
      "compact_15m_gap",
      "pre_catalog",
      MIN_MAINTENANCE_TASK_MS,
      0,
      (remainingMs) => store.compact15Minute(cursor, chunkEnd, now, remainingMs)
    )
    const promoteHourChunk = await runGuarded(
      budget,
      "promote_hour_gap",
      "pre_catalog",
      MIN_MAINTENANCE_TASK_MS,
      0,
      (remainingMs) =>
        store.promoteRollups("15m", "hour", cursor, chunkEnd, remainingMs)
    )
    const promoteDayChunk = await runGuarded(
      budget,
      "promote_day_gap",
      "pre_catalog",
      MIN_MAINTENANCE_TASK_MS,
      0,
      (remainingMs) =>
        store.promoteRollups("hour", "day", cursor, chunkEnd, remainingMs)
    )
    rollups += compactChunk
    rollups += promoteHourChunk
    rollups += promoteDayChunk
    cursor = chunkEnd
  }

  // 4. Middle pre-catalog: recent 15m compaction as its own guarded step.
  rollups += await runGuarded(
    budget,
    "compact_15m_recent",
    "pre_catalog",
    MIN_MAINTENANCE_TASK_MS,
    0,
    (remainingMs) =>
      store.compact15Minute(recentCompactStart, now, now, remainingMs)
  )

  // 5. Middle pre-catalog: hourly then daily promotion, separate awaits.
  rollups += await runGuarded(
    budget,
    "promote_hour_recent",
    "pre_catalog",
    MIN_MAINTENANCE_TASK_MS,
    0,
    (remainingMs) =>
      store.promoteRollups("15m", "hour", recentCompactStart, now, remainingMs)
  )
  rollups += await runGuarded(
    budget,
    "promote_day_recent",
    "pre_catalog",
    MIN_MAINTENANCE_TASK_MS,
    0,
    (remainingMs) =>
      store.promoteRollups("hour", "day", recentCompactStart, now, remainingMs)
  )

  // 6. Middle pre-catalog: retention drains.
  const deleted =
    (await drainBatches(
      "telemetry_retention",
      (limit, remainingMs) =>
        store.enforceTelemetryRetention(now, governorMode, limit, remainingMs),
      budget
    )) +
    (await drainBatches(
      "usage_retention",
      (limit, remainingMs) =>
        store.retainUsageSnapshots(now, limit, remainingMs),
      budget
    )) +
    (await drainBatches(
      "exception_retention",
      (limit, remainingMs) => store.retainExceptions(now, limit, remainingMs),
      budget
    )) +
    (await drainBatches(
      "payload_retention",
      (limit, remainingMs) =>
        store.retainExceptionPayloads(now, limit, remainingMs),
      budget
    )) +
    (await drainBatches(
      "delete_raw_checks",
      (limit, remainingMs) =>
        store.deleteRawChecks(rawCutoff, limit, remainingMs),
      budget
    )) +
    (await drainBatches(
      "delete_sent_notifications",
      (limit, remainingMs) =>
        store.deleteSentNotifications(sentCutoff, limit, remainingMs),
      budget
    )) +
    (await drainBatches(
      "retain_config_snapshots",
      (limit, remainingMs) =>
        store.retainConfigSnapshots(rejectedCutoff, 50, limit, remainingMs),
      budget
    )) +
    (await drainBatches(
      "delete_old_cron_runs",
      (limit, remainingMs) =>
        store.deleteOldCronRuns(cronCutoff, limit, remainingMs),
      budget
    )) +
    (await drainBatches(
      "delete_old_rollups",
      (limit, remainingMs) =>
        store.deleteOldRollups(rollupCutoff, limit, remainingMs),
      budget
    )) +
    (await drainBatches(
      "delete_orphan_images",
      (limit, remainingMs) =>
        store.deleteOrphanImages(
          orphanImageCutoff,
          ORPHAN_IMAGE_KEEP_NEWEST,
          limit,
          remainingMs
        ),
      budget
    )) +
    (await drainBatches(
      "dependency_updates",
      (limit, remainingMs) =>
        store.retainDependencyIncidentUpdates(
          dependencyRetentionCutoff,
          limit,
          remainingMs
        ),
      budget
    )) +
    (await drainBatches(
      "dependency_compact",
      (limit, remainingMs) =>
        store.compactDependencyStateIntervals(
          dependencyRetentionCutoff,
          limit,
          remainingMs
        ),
      budget
    ))
  const expired =
    (await drainBatches(
      "expire_config_approvals",
      (limit, remainingMs) =>
        store.expireConfigApprovals(
          now,
          consumedApprovalCutoff,
          limit,
          remainingMs
        ),
      budget
    )) +
    (await drainBatches(
      "expire_api_idempotency",
      (limit, remainingMs) =>
        store.expireApiIdempotency(now, limit, remainingMs),
      budget
    )) +
    (await drainBatches(
      "mark_device_expired",
      (limit, remainingMs) =>
        store.markDeviceAuthorizationsExpired(now, limit, remainingMs),
      budget
    )) +
    (await drainBatches(
      "delete_device_expired",
      (limit, remainingMs) =>
        store.deleteExpiredDeviceAuthorizations(
          shortCutoff,
          limit,
          remainingMs
        ),
      budget
    )) +
    (await drainBatches(
      "expire_rate_limit",
      (limit, remainingMs) =>
        store.expireRateLimitBuckets(now, limit, remainingMs),
      budget
    ))

  // 7. Final hard-deadline catalog reconciliation with a per-pass slice cap.
  // Catalog retains its reserved opportunity: pre-catalog work stopped at the
  // reserved boundary, so this pass still runs when the hard window remains.
  const catalogStartMs = nowMs()
  const catalogDeadlineAtMs = Math.min(
    hardDeadlineAtMs,
    catalogStartMs + CATALOG_VALIDATION_BUDGET_MS
  )
  const dependencyCatalog = await runGuarded(
    budget,
    "catalog_reconciliation",
    "hard",
    MIN_CATALOG_TASK_MS,
    { checkedSources: 0, disabledPresets: 0 },
    async () => store.reconcileDependencyCatalog(now, catalogDeadlineAtMs)
  )

  return {
    staleOutbox,
    staleCronRuns,
    rollups,
    deleted,
    expired,
    governorMode,
    dependencyCatalog,
    skippedTasks: [...budget.skippedTasks],
    deadlineExceeded: budget.deadlineExceeded,
  }
}

/**
 * Frequent, low-cost sweep of short-lived rows (rate-limit buckets, idempotency keys,
 * device authorizations, expired config approvals). These grow fastest and their
 * cleanup would otherwise queue behind heavy daily telemetry retention. The operations
 * are idempotent deletes, so this needs no lease: a concurrent double-run only re-deletes
 * already-expired rows.
 *
 * Fair rounds: each category gets at most one batch per round while the budget
 * remains. A permanent backlog in rate-limit cannot starve later categories.
 */
export async function performSweep(
  store: MaintenanceStore,
  now: Date,
  options: { nowMs?: () => number; deadlineAtMs?: number } = {}
): Promise<SweepSummary> {
  const nowMs = options.nowMs ?? Date.now
  const hardDeadlineAtMs =
    options.deadlineAtMs ?? nowMs() + SWEEP_WORK_BUDGET_MS
  // Sweep has no catalog reservation. catalogBudgetMs 0 makes pre_catalog == hard.
  const budget = createMaintenanceBudget({
    nowMs,
    hardDeadlineAtMs,
    catalogBudgetMs: 0,
  })
  const shortCutoff = new Date(now.getTime() - 7 * 86_400_000)
  const consumedApprovalCutoff = new Date(now.getTime() - 30 * 86_400_000)

  type SweepCategoryKey = keyof SweepSummary["categories"]
  const categories: {
    key: SweepCategoryKey
    task: string
    active: boolean
    total: number
    operation: (limit: number, remainingMs: number) => Promise<number>
  }[] = [
    {
      key: "rateLimit",
      task: "expire_rate_limit",
      active: true,
      total: 0,
      operation: (limit, remainingMs) =>
        store.expireRateLimitBuckets(now, limit, remainingMs),
    },
    {
      key: "apiIdempotency",
      task: "expire_api_idempotency",
      active: true,
      total: 0,
      operation: (limit, remainingMs) =>
        store.expireApiIdempotency(now, limit, remainingMs),
    },
    {
      key: "deviceMark",
      task: "mark_device_expired",
      active: true,
      total: 0,
      operation: (limit, remainingMs) =>
        store.markDeviceAuthorizationsExpired(now, limit, remainingMs),
    },
    {
      key: "deviceDelete",
      task: "delete_device_expired",
      active: true,
      total: 0,
      operation: (limit, remainingMs) =>
        store.deleteExpiredDeviceAuthorizations(
          shortCutoff,
          limit,
          remainingMs
        ),
    },
    {
      key: "configApprovals",
      task: "expire_config_approvals",
      active: true,
      total: 0,
      operation: (limit, remainingMs) =>
        store.expireConfigApprovals(
          now,
          consumedApprovalCutoff,
          limit,
          remainingMs
        ),
    },
  ]

  // Round-robin: one batch per active category per round, until no category
  // can start or every category is drained / budget-skipped.
  while (budget.canStart(MIN_RETENTION_BATCH_MS, "hard")) {
    let progressed = false
    for (const category of categories) {
      if (!category.active) {
        continue
      }
      if (!budget.canStart(MIN_RETENTION_BATCH_MS, "hard")) {
        budget.recordSkip(category.task, "hard_deadline")
        category.active = false
        continue
      }
      try {
        const affected = await category.operation(
          RETENTION_BATCH_SIZE,
          budget.remainingMs("hard")
        )
        category.total += affected
        progressed = true
        if (affected < RETENTION_BATCH_SIZE) {
          category.active = false
        }
      } catch (error) {
        if (isStatementBudgetError(error)) {
          budget.recordSkip(category.task, "hard_deadline")
          category.active = false
          continue
        }
        throw error
      }
    }
    if (!progressed || categories.every((category) => !category.active)) {
      break
    }
  }

  const byKey = Object.fromEntries(
    categories.map((category) => [category.key, category.total])
  ) as SweepSummary["categories"]
  const expired = categories.reduce((sum, category) => sum + category.total, 0)
  return { expired, categories: byKey }
}

export async function runMaintenanceCoordinator(dependencies: {
  leases: LeaseStore
  runs: CronRunStore
  store: MaintenanceStore
  // Deployment identity recorded on the cron_runs row for release-bound proof.
  releaseId: string
  now?: () => Date
  createId?: () => string
}): Promise<
  | { status: "lease-held" }
  | { status: "duplicate"; runId: string }
  | { status: "completed"; runId: string; summary: MaintenanceSummary }
  | { status: "failed"; runId: string; error: string }
> {
  const now = dependencies.now ?? (() => new Date())
  const createId = dependencies.createId ?? randomUUID
  const startedAt = now()
  const runId = createId()
  const ownerId = createId()
  const result = await withLease(
    dependencies.leases,
    MAINTENANCE_LEASE,
    ownerId,
    startedAt,
    async () => {
      if (
        !(await dependencies.runs.start({
          id: runId,
          jobName: "maintenance",
          scheduledMinute: scheduledMinuteAt(startedAt),
          startedAt,
          releaseId: dependencies.releaseId,
        }))
      ) {
        return { status: "duplicate", runId } as const
      }
      try {
        const summary = await performMaintenance(dependencies.store, startedAt)
        await dependencies.runs.complete(runId, now(), emptyRunCounts())
        return { status: "completed", runId, summary } as const
      } catch (error) {
        const failure = toCronRunFailure(error)
        await dependencies.runs.fail(runId, now(), failure)
        return { status: "failed", runId, error: failure.message } as const
      }
    }
  )
  return result.acquired ? result.value : { status: "lease-held" }
}
