import { randomUUID } from "node:crypto";
import { incidentNotificationKey, normalizeRecipient } from "./idempotency";
import type { SqlExecutor } from "./sql";
import type { IncidentOpenedPayload, IncidentResolvedPayload } from "./types";

export const ENQUEUE_NOTIFICATION_SQL = `
insert into notification_outbox (
  id, incident_id, monitor_id, event_type, recipient, idempotency_key,
  payload, status, attempt_count, next_attempt_at, created_at, updated_at
)
values ($1, $2, $3, $4, $5, $6, $7, 'pending', 0, $8, $8, $8)
on conflict (idempotency_key) do nothing
returning id
`;

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
  let inserted = 0;

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
    const rows = await db.query<{ id: string }>(ENQUEUE_NOTIFICATION_SQL, [
      createId(),
      input.incidentId,
      input.monitorId,
      payload.type,
      recipient,
      incidentNotificationKey(input.incidentId, input.event, recipient),
      payload,
      now,
    ]);
    inserted += rows.length;
  }

  return inserted;
}
