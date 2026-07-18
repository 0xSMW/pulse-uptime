import type { ClaimedNotification } from "./types";

export interface SqlExecutor {
  query<T>(text: string, values: readonly unknown[]): Promise<readonly T[]>;
}

export const PROVIDER_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60_000;
export const PROVIDER_IDEMPOTENCY_RETRY_MARGIN_MS = 5 * 60_000;

interface ClaimedRow {
  id: string;
  incident_id: string | null;
  monitor_id: string;
  event_type: ClaimedNotification["eventType"];
  recipient: string;
  idempotency_key: string;
  payload: ClaimedNotification["payload"];
  attempt_count: number;
  claim_token: string;
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
returning outbox.id, outbox.incident_id, outbox.monitor_id, outbox.event_type,
          outbox.recipient, outbox.idempotency_key, outbox.payload,
          outbox.attempt_count, outbox.claim_token
`;

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
`;

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
`;

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
`;

export async function claimNotifications(
  db: SqlExecutor,
  options: { now: Date; limit: number; claimToken: string },
): Promise<ClaimedNotification[]> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new RangeError("Outbox claim limit must be between 1 and 100");
  }
  const rows = await db.query<ClaimedRow>(CLAIM_NOTIFICATIONS_SQL, [
    options.now,
    options.limit,
    options.claimToken,
  ]);
  return rows.map((row) => ({
    id: row.id,
    incidentId: row.incident_id,
    monitorId: row.monitor_id,
    eventType: row.event_type,
    recipient: row.recipient,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    attemptCount: row.attempt_count,
    claimToken: row.claim_token,
  }));
}

export async function reconcileStaleClaims(
  db: SqlExecutor,
  now: Date,
  staleAfterMs = 5 * 60_000,
): Promise<number> {
  const cutoff = new Date(now.getTime() - staleAfterMs);
  const safeRetryCutoff = new Date(
    now.getTime() - (PROVIDER_IDEMPOTENCY_WINDOW_MS - PROVIDER_IDEMPOTENCY_RETRY_MARGIN_MS),
  );
  const rows = await db.query<{ id: string; status: "failed" | "dead" }>(
    RECONCILE_STALE_CLAIMS_SQL,
    [now, cutoff, safeRetryCutoff],
  );
  return rows.length;
}

export async function markNotificationSent(
  db: SqlExecutor,
  claimed: Pick<ClaimedNotification, "id" | "claimToken">,
  providerMessageId: string,
  now: Date,
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(MARK_NOTIFICATION_SENT_SQL, [
    claimed.id,
    claimed.claimToken,
    providerMessageId,
    now,
  ]);
  return rows.length === 1;
}

export async function markNotificationFailed(
  db: SqlExecutor,
  claimed: Pick<ClaimedNotification, "id" | "claimToken">,
  failure: { dead: boolean; nextAttemptAt: Date; errorCode: string; now: Date },
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(MARK_NOTIFICATION_FAILED_SQL, [
    claimed.id,
    claimed.claimToken,
    failure.dead ? "dead" : "failed",
    failure.nextAttemptAt,
    failure.errorCode,
    failure.now,
  ]);
  return rows.length === 1;
}
