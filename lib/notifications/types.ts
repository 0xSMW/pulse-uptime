import { z } from "zod";

export type NotificationEventType = "incident.opened" | "incident.resolved" | "notification.test";

const nonempty = z.string().trim().min(1);

export const incidentOpenedPayloadSchema = z.object({
  type: z.literal("incident.opened"),
  monitorName: nonempty,
  incidentId: nonempty,
  startedAt: nonempty,
  cause: nonempty,
});

export const incidentResolvedPayloadSchema = z.object({
  type: z.literal("incident.resolved"),
  monitorName: nonempty,
  incidentId: nonempty,
  recoveredAt: nonempty,
  duration: nonempty,
});

export const testNotificationPayloadSchema = z.object({
  type: z.literal("notification.test"),
  installationName: nonempty.optional(),
});

export const notificationPayloadSchema = z.discriminatedUnion("type", [
  incidentOpenedPayloadSchema,
  incidentResolvedPayloadSchema,
  testNotificationPayloadSchema,
]);

export type IncidentOpenedPayload = z.infer<typeof incidentOpenedPayloadSchema>;

export type IncidentResolvedPayload = z.infer<typeof incidentResolvedPayloadSchema>;

export type TestNotificationPayload = z.infer<typeof testNotificationPayloadSchema>;

export type NotificationPayload =
  | IncidentOpenedPayload
  | IncidentResolvedPayload
  | TestNotificationPayload;

export interface ClaimedNotification {
  id: string;
  incidentId: string | null;
  monitorId: string;
  eventType: NotificationEventType;
  recipient: string;
  idempotencyKey: string;
  payload: NotificationPayload;
  attemptCount: number;
  claimToken: string;
}

export interface DeliveryLogEntry {
  event: "notification.sent" | "notification.failed";
  notificationId: string;
  incidentId?: string;
  monitorId: string;
  attemptCount: number;
  errorCode?: string;
}

export type NotificationLogger = (entry: DeliveryLogEntry) => void;
