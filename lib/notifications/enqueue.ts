import { randomUUID } from "node:crypto";
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

const DEPENDENCY_COLUMNS_PER_ROW = 7;

function buildEnqueueDependencyRowValues(rowCount: number): string {
  const rows: string[] = [];
  for (let row = 0; row < rowCount; row++) {
    const base = row * DEPENDENCY_COLUMNS_PER_ROW;
    const p = (offset: number) => `$${base + offset}`;
    rows.push(`(${p(1)}, null, null, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, 'pending', 0, ${p(7)}, ${p(7)}, ${p(7)})`);
  }
  return rows.join(",\n");
}

export function buildEnqueueDependencyNotificationSql(rowCount: number): string {
  return `
insert into notification_outbox (
  id, incident_id, monitor_id, dependency_id, event_type, recipient, idempotency_key,
  payload, status, attempt_count, next_attempt_at, created_at, updated_at
)
values
${buildEnqueueDependencyRowValues(rowCount)}
on conflict (idempotency_key) do nothing
returning id
`;
}

export const ENQUEUE_DEPENDENCY_NOTIFICATION_SQL = buildEnqueueDependencyNotificationSql(1);

type DependencyNotificationInput = {
  event: DependencyNotificationEvent;
  sourceId: string;
  incidentExternalId: string;
  presetId: string;
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
  db: SqlExecutor,
  input: DependencyNotificationInput,
  options: { now?: Date; createId?: () => string } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const createId = options.createId ?? randomUUID;
  const recipients = [...new Set(input.recipients.map(normalizeRecipient))];

  if (recipients.length === 0) return 0;

  const values: unknown[] = [];
  for (const recipient of recipients) {
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
    values.push(
      createId(),
      input.dependencyId,
      payload.type,
      recipient,
      dependencyNotificationKey(input.sourceId, input.incidentExternalId, input.presetId, input.event, recipient),
      JSON.stringify(payload),
      now,
    );
  }

  const rows = await db.query<{ id: string }>(
    buildEnqueueDependencyNotificationSql(recipients.length),
    values,
  );
  return rows.length;
}
