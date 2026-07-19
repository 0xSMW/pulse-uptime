import { randomUUID } from "node:crypto";
import { incidentNotificationKey, normalizeRecipient } from "./idempotency";
import type { SqlExecutor } from "./sql";
import type { IncidentOpenedPayload, IncidentResolvedPayload } from "./types";

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
