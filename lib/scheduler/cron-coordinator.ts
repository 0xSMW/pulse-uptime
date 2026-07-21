import { randomUUID } from "node:crypto"

import { type LeaseStore, withLease } from "./lease"
import {
  type CronJobName,
  type CronRunCounts,
  type CronRunStore,
  emptyRunCounts,
  toCronRunFailure,
} from "./run-record"
import { scheduledMinuteAt } from "./time"

export interface CronProgressRecorder {
  /** Store the latest generic counts snapshot for fail-path persistence. */
  record: (counts: CronRunCounts) => void
}

export interface CronWorkContext {
  runId: string
  startedAt: Date
  scheduledMinute: Date
  progress: CronProgressRecorder
}

/** Domain work must return counts; extra fields merge into the completed result. */
export type CronWorkResult = {
  counts: CronRunCounts
} & Record<string, unknown>

export type CronCoordinatorResult<TCompleted extends CronWorkResult> =
  | { status: "lease-held" }
  | { status: "duplicate"; runId: string }
  | ({ status: "completed"; runId: string } & TCompleted)
  | { status: "failed"; runId: string; error: string }

export interface CronCoordinatorDependencies {
  leases: LeaseStore
  runs: CronRunStore
  leaseName: string
  jobName: CronJobName
  releaseId: string
  now?: () => Date
  createId?: () => string
}

function createProgressRecorder(): {
  record: (counts: CronRunCounts) => void
  snapshot: () => CronRunCounts
} {
  let latest = emptyRunCounts()
  return {
    record(counts) {
      latest = {
        monitorCount: counts.monitorCount,
        successCount: counts.successCount,
        failureCount: counts.failureCount,
        skippedCount: counts.skippedCount,
      }
    },
    snapshot() {
      return {
        monitorCount: latest.monitorCount,
        successCount: latest.successCount,
        failureCount: latest.failureCount,
        skippedCount: latest.skippedCount,
      }
    },
  }
}

/**
 * Shared cron lease + run lifecycle. Domain code supplies work; this module
 * owns acquire, scheduled-minute identity, duplicate start, complete/fail,
 * and release. Progress recorded mid-work is persisted on the fail path.
 */
export async function runCronCoordinator<TCompleted extends CronWorkResult>(
  dependencies: CronCoordinatorDependencies,
  work: (context: CronWorkContext) => Promise<TCompleted>
): Promise<CronCoordinatorResult<TCompleted>> {
  const now = dependencies.now ?? (() => new Date())
  const createId = dependencies.createId ?? randomUUID
  const startedAt = now()
  const scheduledMinute = scheduledMinuteAt(startedAt)
  const ownerId = createId()
  const runId = createId()
  const progress = createProgressRecorder()

  const leased = await withLease(
    dependencies.leases,
    dependencies.leaseName,
    ownerId,
    startedAt,
    async () => {
      if (
        !(await dependencies.runs.start({
          id: runId,
          jobName: dependencies.jobName,
          scheduledMinute,
          startedAt,
          releaseId: dependencies.releaseId,
        }))
      ) {
        return { status: "duplicate", runId } as const
      }

      try {
        const completed = await work({
          runId,
          startedAt,
          scheduledMinute,
          progress,
        })
        await dependencies.runs.complete(runId, now(), completed.counts)
        return { status: "completed", runId, ...completed } as {
          status: "completed"
          runId: string
        } & TCompleted
      } catch (error) {
        const failure = toCronRunFailure(error)
        await dependencies.runs.fail(runId, now(), failure, progress.snapshot())
        return { status: "failed", runId, error: failure.message } as const
      }
    }
  )

  return leased.acquired ? leased.value : { status: "lease-held" }
}
