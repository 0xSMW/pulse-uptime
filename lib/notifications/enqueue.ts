import { randomUUID } from "node:crypto"

import type { DatabaseHandle } from "@/lib/db/client"
import { notificationOutbox } from "@/lib/db/schema"

import {
  type DependencyNotificationEvent,
  dependencyNotificationKey,
  normalizeRecipient,
} from "./idempotency"
import type {
  DependencyIncidentPayload,
  DependencyRecoveryPayload,
} from "./types"

// -- Dependency notifications -------------------------------------------
//
// Dependency rows have no monitor: monitor_id and incident_id stay null,
// dependency_id identifies the subject instead. Everything the email needs
// to render travels in the payload, so delivery never joins back to
// dependency tables.
//
// Takes a Drizzle database handle (a plain connection or a transaction)
// rather than a SqlExecutor: persist.ts calls this with the same
// transaction handle it uses for the state, interval, and match writes in
// the same poll, so the row inserted here commits or rolls back with them
// instead of autocommitting on a separate connection.

type DependencyNotificationInput = {
  event: DependencyNotificationEvent
  sourceId: string
  incidentExternalId: string
  presetId: string
  scopeId: string | null
  dependencyId: string
  dependencyName: string
  provider: string
  incidentTitle: string
  state: string
  canonicalUrl: string | null
  providerTimestamp: string
  recipients: readonly string[]
}

export async function enqueueDependencyNotifications(
  db: DatabaseHandle,
  input: DependencyNotificationInput,
  options: { now?: Date; createId?: () => string } = {}
): Promise<number> {
  const now = options.now ?? new Date()
  const createId = options.createId ?? randomUUID
  const recipients = [...new Set(input.recipients.map(normalizeRecipient))]

  if (recipients.length === 0) {
    return 0
  }

  const payload: DependencyIncidentPayload | DependencyRecoveryPayload =
    input.event === "incident"
      ? {
          type: "dependency.incident",
          dependencyName: input.dependencyName,
          provider: input.provider,
          incidentTitle: input.incidentTitle,
          state: input.state,
          canonicalUrl: input.canonicalUrl,
          providerTimestamp: input.providerTimestamp,
        }
      : {
          type: "dependency.recovery",
          dependencyName: input.dependencyName,
          provider: input.provider,
          incidentTitle: input.incidentTitle,
          state: input.state,
          canonicalUrl: input.canonicalUrl,
          providerTimestamp: input.providerTimestamp,
        }

  const rows = recipients.map((recipient) => ({
    id: createId(),
    dependencyId: input.dependencyId,
    eventType: payload.type,
    recipient,
    idempotencyKey: dependencyNotificationKey(
      input.sourceId,
      input.incidentExternalId,
      input.presetId,
      input.scopeId,
      input.event,
      recipient
    ),
    payload,
    status: "pending" as const,
    attemptCount: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  }))

  const inserted = await db
    .insert(notificationOutbox)
    .values(rows)
    .onConflictDoNothing({ target: notificationOutbox.idempotencyKey })
    .returning({ id: notificationOutbox.id })
  return inserted.length
}
