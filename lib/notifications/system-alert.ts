import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { DatabaseHandle } from "@/lib/db/client";
import { notificationOutbox } from "@/lib/db/schema";

import { hourBucket, normalizeRecipient, systemAlertKey } from "./idempotency";
import type { SystemAlertPayload } from "./types";

// -- System self-alerts -------------------------------------------------
//
// A system.alert names no monitor and no dependency: monitor_id and
// dependency_id both stay null, permitted by the notification_outbox_subject
// check. The alert body travels entirely in the payload so delivery renders it
// without joining anything.

export type SystemAlertInput = {
  // Stable kind used in the dedup key, for example "monitoring-loop-failure".
  kind: string;
  title: string;
  detail: string;
  reason: string;
  detectedAt: Date;
  recipients: readonly string[];
};

export type EnqueuedSystemAlert = {
  id: string;
  recipient: string;
  idempotencyKey: string;
  payload: SystemAlertPayload;
};

/**
 * Enqueues one outbox row per distinct recipient, deduplicated by kind, hour
 * bucket, and recipient. Returns only the rows actually inserted, so a caller
 * can tell a fresh alert (send it now) from one already raised this bucket
 * (do nothing). Conflicts are ignored, never overwritten.
 */
export async function enqueueSystemAlert(
  db: DatabaseHandle,
  input: SystemAlertInput,
  options: { now?: Date; createId?: () => string } = {},
): Promise<EnqueuedSystemAlert[]> {
  const now = options.now ?? new Date();
  const createId = options.createId ?? randomUUID;
  const recipients = [...new Set(input.recipients.map(normalizeRecipient))].filter((recipient) => recipient.length > 0);
  if (recipients.length === 0) return [];

  const bucket = hourBucket(input.detectedAt);
  const payload: SystemAlertPayload = {
    type: "system.alert",
    title: input.title,
    detail: input.detail,
    reason: input.reason,
    detectedAt: input.detectedAt.toISOString(),
  };

  const rows = recipients.map((recipient) => ({
    id: createId(),
    eventType: "system.alert",
    recipient,
    idempotencyKey: systemAlertKey(input.kind, bucket, recipient),
    payload,
    status: "pending" as const,
    attemptCount: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  }));

  const inserted = await db.insert(notificationOutbox)
    .values(rows)
    .onConflictDoNothing({ target: notificationOutbox.idempotencyKey })
    .returning({
      id: notificationOutbox.id,
      recipient: notificationOutbox.recipient,
      idempotencyKey: notificationOutbox.idempotencyKey,
    });

  return inserted.map((row) => ({
    id: row.id,
    recipient: row.recipient,
    idempotencyKey: row.idempotencyKey,
    payload,
  }));
}

/**
 * Marks a still-pending system alert as sent after an out-of-band direct send.
 * The `status = 'pending'` guard means a row already claimed by the outbox
 * drainer is left alone, so this never fights the normal delivery path.
 */
export async function markSystemAlertSent(
  db: DatabaseHandle,
  id: string,
  providerMessageId: string,
  now: Date,
): Promise<void> {
  await db.update(notificationOutbox)
    .set({ status: "sent", providerMessageId, sentAt: now, lastError: null, updatedAt: now })
    .where(and(eq(notificationOutbox.id, id), eq(notificationOutbox.status, "pending")));
}
