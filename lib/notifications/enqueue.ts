import { randomUUID } from "node:crypto";

import type { DatabaseHandle } from "@/lib/db/client";
import { notificationOutbox } from "@/lib/db/schema";

import { dependencyNotificationKey, incidentNotificationKey, normalizeRecipient, type DependencyNotificationEvent } from "./idempotency";
import type { SqlExecutor } from "./sql";
import type { DependencyIncidentPayload, DependencyRecoveryPayload, IncidentOpenedPayload, IncidentResolvedPayload } from "./types";

const COLUMNS_PER_ROW = 8;

function buildEnqueueRowValues(rowCount: number): string {
  const rows: string[] = [];
  for (let row = 0; row < rowCount; row++) {
    const base = row * COLUMNS_PER_ROW;
    const p = (offset: number) => `$${base + offset}`;
    rows.push(`(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, 'pending', 0, ${p(8)}, ${p(8)}, ${p(8)})`);
  }
  return rows.join(",\n");
}

export function buildEnqueueNotificationSql(rowCount: number): string {
  return `
insert into notification_outbox (
  id, incident_id, monitor_id, event_type, recipient, idempotency_key,
  payload, status, attempt_count, next_attempt_at, created_at, updated_at
)
values
${buildEnqueueRowValues(rowCount)}
on conflict (idempotency_key) do nothing
returning id
`;
}

export const ENQUEUE_NOTIFICATION_SQL = buildEnqueueNotificationSql(1);

type IncidentEventInput =
  | {
      event: "opened";
      incidentId: string;
      monitorId: string;
      monitorName: string;
      recipients: readonly string[];
      startedAt: string;
      cause: string;
    }
  | {
      event: "resolved";
      incidentId: string;
      monitorId: string;
      monitorName: string;
      recipients: readonly string[];
      recoveredAt: string;
      duration: string;
    };

export async function enqueueIncidentNotifications(
  db: SqlExecutor,
  input: IncidentEventInput,
  options: { now?: Date; createId?: () => string } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const createId = options.createId ?? randomUUID;
  const recipients = [...new Set(input.recipients.map(normalizeRecipient))];

  if (recipients.length === 0) {
    return 0;
  }

  const values: unknown[] = [];
  for (const recipient of recipients) {
    const payload: IncidentOpenedPayload | IncidentResolvedPayload = input.event === "opened"
      ? {
          type: "incident.opened",
          monitorName: input.monitorName,
          incidentId: input.incidentId,
          startedAt: input.startedAt,
          cause: input.cause,
        }
      : {
          type: "incident.resolved",
          monitorName: input.monitorName,
          incidentId: input.incidentId,
          recoveredAt: input.recoveredAt,
          duration: input.duration,
        };
    values.push(
      createId(),
      input.incidentId,
      input.monitorId,
      payload.type,
      recipient,
      incidentNotificationKey(input.incidentId, input.event, recipient),
      JSON.stringify(payload),
      now,
    );
  }

  const rows = await db.query<{ id: string }>(
    buildEnqueueNotificationSql(recipients.length),
    values,
  );
  return rows.length;
}

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
  event: DependencyNotificationEvent;
  sourceId: string;
  incidentExternalId: string;
  presetId: string;
  scopeId: string | null;
  dependencyId: string;
  dependencyName: string;
  provider: string;
  incidentTitle: string;
  state: string;
  canonicalUrl: string | null;
  providerTimestamp: string;
  recipients: readonly string[];
};

export async function enqueueDependencyNotifications(
  db: DatabaseHandle,
  input: DependencyNotificationInput,
  options: { now?: Date; createId?: () => string } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const createId = options.createId ?? randomUUID;
  const recipients = [...new Set(input.recipients.map(normalizeRecipient))];

  if (recipients.length === 0) return 0;

  const payload: DependencyIncidentPayload | DependencyRecoveryPayload = input.event === "incident"
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
      };

  const rows = recipients.map((recipient) => ({
    id: createId(),
    dependencyId: input.dependencyId,
    eventType: payload.type,
    recipient,
    idempotencyKey: dependencyNotificationKey(input.sourceId, input.incidentExternalId, input.presetId, input.scopeId, input.event, recipient),
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
    .returning({ id: notificationOutbox.id });
  return inserted.length;
}
