import type { ClaimedNotification, NotificationEventType } from "./types"

export interface SqlExecutor {
  query<T>(text: string, values: readonly unknown[]): Promise<readonly T[]>
}

export const PROVIDER_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60_000
export const PROVIDER_IDEMPOTENCY_RETRY_MARGIN_MS = 5 * 60_000

interface ClaimedRow {
  id: string
  incident_id: string | null
  monitor_id: string | null
  dependency_id: string | null
  event_type: ClaimedNotification["eventType"]
  recipient: string
  idempotency_key: string
  payload: ClaimedNotification["payload"]
  attempt_count: number
  claim_token: string
}

export type ClaimNotificationsOptions = {
  now: Date
  limit: number
  claimToken: string
  /** When set, only claim rows whose event_type is in this list. */
  eventTypes?: readonly NotificationEventType[]
}

export type ReconcileStaleClaimsOptions = {
  /** When set, only reconcile rows whose event_type is in this list. */
  eventTypes?: readonly NotificationEventType[]
}

export const CLAIM_NOTIFICATIONS_SQL = `
with due as (
  select id
  from notification_outbox
  where status in ('pending', 'failed')
    and next_attempt_at <= $1
  order by next_attempt_at, created_at, id
  for update skip locked
  limit $2
)
update notification_outbox as outbox
set status = 'sending',
    attempt_count = outbox.attempt_count + 1,
    claim_token = $3,
    claimed_at = $1,
    updated_at = $1
from due
where outbox.id = due.id
returning outbox.id, outbox.incident_id, outbox.monitor_id, outbox.dependency_id, outbox.event_type,
          outbox.recipient, outbox.idempotency_key, outbox.payload,
          outbox.attempt_count, outbox.claim_token
`

// Same claim path with an event_type scope so a dedicated consumer (for example
// the sweep system.alert drain) never steals ordinary incident or dependency
// outbox work, and the monitor-check drainer can keep claiming the rest.
export const CLAIM_NOTIFICATIONS_BY_EVENT_TYPE_SQL = `
with due as (
  select id
  from notification_outbox
  where status in ('pending', 'failed')
    and next_attempt_at <= $1
    and event_type = any($4)
  order by next_attempt_at, created_at, id
  for update skip locked
  limit $2
)
update notification_outbox as outbox
set status = 'sending',
    attempt_count = outbox.attempt_count + 1,
    claim_token = $3,
    claimed_at = $1,
    updated_at = $1
from due
where outbox.id = due.id
returning outbox.id, outbox.incident_id, outbox.monitor_id, outbox.dependency_id, outbox.event_type,
          outbox.recipient, outbox.idempotency_key, outbox.payload,
          outbox.attempt_count, outbox.claim_token
`

export const RECONCILE_STALE_CLAIMS_SQL = `
update notification_outbox
set status = case when claimed_at <= $3 then 'dead' else 'failed' end,
    next_attempt_at = $1,
    claim_token = null,
    claimed_at = null,
    last_error = case
      when claimed_at <= $3 then 'AMBIGUOUS_PROVIDER_RESULT'
      else 'STALE_CLAIM'
    end,
    updated_at = $1
where status = 'sending'
  and claimed_at < $2
returning id, status
`

export const RECONCILE_STALE_CLAIMS_BY_EVENT_TYPE_SQL = `
update notification_outbox
set status = case when claimed_at <= $3 then 'dead' else 'failed' end,
    next_attempt_at = $1,
    claim_token = null,
    claimed_at = null,
    last_error = case
      when claimed_at <= $3 then 'AMBIGUOUS_PROVIDER_RESULT'
      else 'STALE_CLAIM'
    end,
    updated_at = $1
where status = 'sending'
  and claimed_at < $2
  and event_type = any($4)
returning id, status
`

export const MARK_NOTIFICATION_SENT_SQL = `
update notification_outbox
set status = 'sent',
    provider_message_id = $3,
    sent_at = $4,
    claim_token = null,
    claimed_at = null,
    last_error = null,
    updated_at = $4
where id = $1
  and status = 'sending'
  and claim_token = $2
returning id
`

export const MARK_NOTIFICATION_FAILED_SQL = `
update notification_outbox
set status = $3,
    next_attempt_at = $4,
    claim_token = null,
    claimed_at = null,
    last_error = $5,
    updated_at = $6
where id = $1
  and status = 'sending'
  and claim_token = $2
returning id
`

function mapClaimedRows(rows: readonly ClaimedRow[]): ClaimedNotification[] {
  return rows.map((row) => ({
    id: row.id,
    incidentId: row.incident_id,
    monitorId: row.monitor_id,
    dependencyId: row.dependency_id,
    eventType: row.event_type,
    recipient: row.recipient,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    attemptCount: row.attempt_count,
    claimToken: row.claim_token,
  }))
}

export async function claimNotifications(
  db: SqlExecutor,
  options: ClaimNotificationsOptions
): Promise<ClaimedNotification[]> {
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  ) {
    throw new RangeError("Outbox claim limit must be between 1 and 100")
  }
  const eventTypes = options.eventTypes
  if (eventTypes && eventTypes.length > 0) {
    const rows = await db.query<ClaimedRow>(
      CLAIM_NOTIFICATIONS_BY_EVENT_TYPE_SQL,
      [options.now, options.limit, options.claimToken, [...eventTypes]]
    )
    return mapClaimedRows(rows)
  }
  const rows = await db.query<ClaimedRow>(CLAIM_NOTIFICATIONS_SQL, [
    options.now,
    options.limit,
    options.claimToken,
  ])
  return mapClaimedRows(rows)
}

export async function reconcileStaleClaims(
  db: SqlExecutor,
  now: Date,
  staleAfterMs = 5 * 60_000,
  options: ReconcileStaleClaimsOptions = {}
): Promise<number> {
  const cutoff = new Date(now.getTime() - staleAfterMs)
  const safeRetryCutoff = new Date(
    now.getTime() -
      (PROVIDER_IDEMPOTENCY_WINDOW_MS - PROVIDER_IDEMPOTENCY_RETRY_MARGIN_MS)
  )
  const eventTypes = options.eventTypes
  if (eventTypes && eventTypes.length > 0) {
    const rows = await db.query<{ id: string; status: "failed" | "dead" }>(
      RECONCILE_STALE_CLAIMS_BY_EVENT_TYPE_SQL,
      [now, cutoff, safeRetryCutoff, [...eventTypes]]
    )
    return rows.length
  }
  const rows = await db.query<{ id: string; status: "failed" | "dead" }>(
    RECONCILE_STALE_CLAIMS_SQL,
    [now, cutoff, safeRetryCutoff]
  )
  return rows.length
}

export async function markNotificationSent(
  db: SqlExecutor,
  claimed: Pick<ClaimedNotification, "id" | "claimToken">,
  providerMessageId: string,
  now: Date
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(MARK_NOTIFICATION_SENT_SQL, [
    claimed.id,
    claimed.claimToken,
    providerMessageId,
    now,
  ])
  return rows.length === 1
}

export async function markNotificationFailed(
  db: SqlExecutor,
  claimed: Pick<ClaimedNotification, "id" | "claimToken">,
  failure: { dead: boolean; nextAttemptAt: Date; errorCode: string; now: Date }
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(MARK_NOTIFICATION_FAILED_SQL, [
    claimed.id,
    claimed.claimToken,
    failure.dead ? "dead" : "failed",
    failure.nextAttemptAt,
    failure.errorCode,
    failure.now,
  ])
  return rows.length === 1
}
