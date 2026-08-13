import { randomUUID } from "node:crypto"
import { runBoundedWork } from "@/lib/async/bounded-work"
import {
  createNotificationMessage,
  InvalidNotificationPayloadError,
} from "./message"
import { NotificationProviderError, type NotificationSender } from "./provider"
import {
  claimNotifications,
  isStatementTimeout,
  markNotificationFailed,
  markNotificationSent,
  releaseNotificationClaims,
  type SqlExecutor,
} from "./sql"
import type {
  ClaimedNotification,
  NotificationEventType,
  NotificationLogger,
} from "./types"

const MAX_DELIVERY_ATTEMPTS = 5
const MAX_CLAIM_BATCH_SIZE = 100
const MAX_SEND_CONCURRENCY = 10
export const DEFAULT_NOTIFICATION_SEND_TIMEOUT_MS = 8000
export const DEFAULT_NOTIFICATION_DRAIN_TIMEOUT_MS = 15_000
const NOTIFICATION_CLAIM_RELEASE_RESERVE_MS = 1000
const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
] as const

export function retryAt(now: Date, attemptCount: number): Date {
  const index = Math.max(
    0,
    Math.min(attemptCount - 1, RETRY_DELAYS_MS.length - 1)
  )
  return new Date(now.getTime() + RETRY_DELAYS_MS[index]!)
}

export interface DeliveryDependencies {
  db: SqlExecutor
  sender: NotificationSender
  appUrl: string
  log?: NotificationLogger
  now?: () => Date
  createClaimToken?: () => string
}

export interface DeliverySummary {
  claimed: number
  sent: number
  failed: number
  dead: number
  lostClaims: number
}

/** One row's outcome after provider work and successful claim bookkeeping. */
type RowDeliveryOutcome =
  | { kind: "sent" }
  | { kind: "failed" }
  | { kind: "dead" }
  | { kind: "lost_claim" }

/**
 * Raised when mark-sent / mark-failed (or other claim bookkeeping) throws for
 * one or more rows. The pool always drains first. `summary` holds counts from
 * rows whose bookkeeping completed. `notificationIds` are safe row ids only.
 */
export class NotificationDeliveryInfrastructureError extends Error {
  override readonly name = "NotificationDeliveryInfrastructureError"

  constructor(
    readonly notificationIds: readonly string[],
    readonly summary: DeliverySummary,
    options?: ErrorOptions
  ) {
    const ids = notificationIds.join(", ")
    super(
      notificationIds.length === 1
        ? `Notification delivery bookkeeping failed for row ${ids}`
        : `Notification delivery bookkeeping failed for rows ${ids}`,
      options
    )
  }
}

function safeFailure(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof NotificationProviderError) {
    return { code: error.code, retryable: error.retryable }
  }
  if (error instanceof InvalidNotificationPayloadError) {
    return { code: error.code, retryable: false }
  }
  return { code: "PROVIDER_UNAVAILABLE", retryable: true }
}

async function deliverClaimedRow(
  row: ClaimedNotification,
  dependencies: DeliveryDependencies,
  now: Date,
  deadline: {
    atMs: number
    bookkeepingAtMs: number
    perSendTimeoutMs: number
    nowMs: () => number
  }
): Promise<RowDeliveryOutcome> {
  let providerMessageId: string
  try {
    const message = createNotificationMessage(row, dependencies.appUrl)
    const remainingMs = Math.min(
      deadline.perSendTimeoutMs,
      deadline.atMs - deadline.nowMs()
    )
    if (remainingMs <= 0) {
      throw new NotificationProviderError("delivery_timeout", {
        retryable: true,
      })
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), remainingMs)
    let result: Awaited<ReturnType<NotificationSender["send"]>>
    try {
      result = await dependencies.sender.send(
        message,
        row.idempotencyKey,
        controller.signal
      )
    } catch (error) {
      if (controller.signal.aborted) {
        throw new NotificationProviderError("delivery_timeout", {
          retryable: true,
          cause: error,
        })
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
    providerMessageId = result.providerMessageId
  } catch (error) {
    // Provider or payload failure. Bookkeeping throws stay uncaught so the
    // settled pool records them as infrastructure rejections.
    const failure = safeFailure(error)
    const dead = !failure.retryable || row.attemptCount >= MAX_DELIVERY_ATTEMPTS
    let persisted: boolean
    try {
      persisted = await markNotificationFailed(
        dependencies.db,
        row,
        {
          dead,
          nextAttemptAt: retryAt(now, row.attemptCount),
          errorCode: failure.code,
          now,
        },
        {
          deadlineAtMs: deadline.bookkeepingAtMs,
          nowMs: deadline.nowMs,
        }
      )
    } catch (bookkeepingError) {
      if (isStatementTimeout(bookkeepingError)) {
        return { kind: "lost_claim" }
      }
      throw bookkeepingError
    }
    if (!persisted) {
      return { kind: "lost_claim" }
    }
    dependencies.log?.({
      event: "notification.failed",
      notificationId: row.id,
      ...(row.incidentId ? { incidentId: row.incidentId } : {}),
      ...(row.monitorId ? { monitorId: row.monitorId } : {}),
      ...(row.dependencyId ? { dependencyId: row.dependencyId } : {}),
      attemptCount: row.attemptCount,
      errorCode: failure.code,
    })
    return dead ? { kind: "dead" } : { kind: "failed" }
  }

  let persisted: boolean
  try {
    persisted = await markNotificationSent(
      dependencies.db,
      row,
      providerMessageId,
      now,
      {
        deadlineAtMs: deadline.bookkeepingAtMs,
        nowMs: deadline.nowMs,
      }
    )
  } catch (error) {
    if (isStatementTimeout(error)) {
      return { kind: "lost_claim" }
    }
    throw error
  }
  if (!persisted) {
    return { kind: "lost_claim" }
  }
  dependencies.log?.({
    event: "notification.sent",
    notificationId: row.id,
    ...(row.incidentId ? { incidentId: row.incidentId } : {}),
    ...(row.monitorId ? { monitorId: row.monitorId } : {}),
    ...(row.dependencyId ? { dependencyId: row.dependencyId } : {}),
    attemptCount: row.attemptCount,
  })
  return { kind: "sent" }
}

function applyRowOutcome(
  summary: DeliverySummary,
  outcome: RowDeliveryOutcome
): void {
  if (outcome.kind === "sent") {
    summary.sent += 1
    return
  }
  if (outcome.kind === "failed") {
    summary.failed += 1
    return
  }
  if (outcome.kind === "dead") {
    summary.dead += 1
    return
  }
  summary.lostClaims += 1
}

export async function deliverPendingNotifications(
  dependencies: DeliveryDependencies,
  options: {
    limit?: number
    concurrency?: number
    perSendTimeoutMs?: number
    deadlineAtMs?: number
    nowMs?: () => number
    /** When set, only claim and deliver rows of these event types. */
    eventTypes?: readonly NotificationEventType[]
  } = {}
): Promise<DeliverySummary> {
  const limit = options.limit ?? 50
  const concurrency = options.concurrency ?? 5
  const perSendTimeoutMs =
    options.perSendTimeoutMs ?? DEFAULT_NOTIFICATION_SEND_TIMEOUT_MS
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CLAIM_BATCH_SIZE) {
    throw new RangeError("Delivery limit must be between 1 and 100")
  }
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_SEND_CONCURRENCY
  ) {
    throw new RangeError("Delivery concurrency must be between 1 and 10")
  }
  if (!Number.isFinite(perSendTimeoutMs) || perSendTimeoutMs <= 0) {
    throw new RangeError("Delivery send timeout must be positive")
  }

  const nowMs = options.nowMs ?? Date.now
  const deadlineAtMs =
    options.deadlineAtMs ?? nowMs() + DEFAULT_NOTIFICATION_DRAIN_TIMEOUT_MS
  if (!Number.isFinite(deadlineAtMs)) {
    throw new RangeError("Delivery deadline must be finite")
  }

  if (deadlineAtMs <= nowMs()) {
    return { claimed: 0, sent: 0, failed: 0, dead: 0, lostClaims: 0 }
  }

  const now = (dependencies.now ?? (() => new Date()))()
  let rows: ClaimedNotification[]
  try {
    rows = await claimNotifications(dependencies.db, {
      now,
      limit,
      claimToken: (dependencies.createClaimToken ?? randomUUID)(),
      deadlineAtMs,
      nowMs,
      ...(options.eventTypes && options.eventTypes.length > 0
        ? { eventTypes: options.eventTypes }
        : {}),
    })
  } catch (error) {
    if (isStatementTimeout(error)) {
      return { claimed: 0, sent: 0, failed: 0, dead: 0, lostClaims: 0 }
    }
    throw error
  }
  const summary: DeliverySummary = {
    claimed: rows.length,
    sent: 0,
    failed: 0,
    dead: 0,
    lostClaims: 0,
  }

  // Settled pool: every started send finishes before return. Provider failures
  // and bookkeeping failures are captured per row, not via Promise.all reject.
  const sendDeadlineAtMs = Math.max(
    nowMs(),
    deadlineAtMs - NOTIFICATION_CLAIM_RELEASE_RESERVE_MS
  )
  const outcomes = await runBoundedWork(rows, {
    concurrency,
    shouldStop: () => nowMs() >= sendDeadlineAtMs,
    worker: (row) =>
      deliverClaimedRow(row, dependencies, now, {
        atMs: sendDeadlineAtMs,
        bookkeepingAtMs: deadlineAtMs,
        perSendTimeoutMs,
        nowMs,
      }),
  })

  const failedIds: string[] = []
  const causes: unknown[] = []
  const skippedRows: ClaimedNotification[] = []
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index]
    const row = rows[index]
    if (!(outcome && row)) {
      continue
    }
    if (outcome.status === "fulfilled") {
      applyRowOutcome(summary, outcome.value)
      continue
    }
    if (outcome.status === "rejected") {
      failedIds.push(row.id)
      causes.push(outcome.reason)
      continue
    }
    if (outcome.status === "skipped") {
      skippedRows.push(row)
    }
  }

  if (skippedRows.length > 0) {
    try {
      const released = await releaseNotificationClaims(
        dependencies.db,
        skippedRows,
        now,
        { deadlineAtMs, nowMs }
      )
      summary.lostClaims += skippedRows.length - released
    } catch (error) {
      if (isStatementTimeout(error)) {
        summary.lostClaims += skippedRows.length
      } else {
        failedIds.push(...skippedRows.map((row) => row.id))
        causes.push(error)
      }
    }
  }

  if (failedIds.length > 0) {
    throw new NotificationDeliveryInfrastructureError(failedIds, summary, {
      cause:
        causes.length === 1
          ? causes[0]
          : new AggregateError(causes, "Multiple bookkeeping failures"),
    })
  }

  return summary
}
