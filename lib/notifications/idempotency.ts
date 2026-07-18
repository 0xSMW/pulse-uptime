import { createHash } from "node:crypto";

export type IncidentNotificationEvent = "opened" | "resolved";

export function normalizeRecipient(recipient: string): string {
  return recipient.trim().toLowerCase();
}

export function recipientHash(recipient: string): string {
  return createHash("sha256").update(normalizeRecipient(recipient)).digest("hex");
}

export function incidentNotificationKey(
  incidentId: string,
  event: IncidentNotificationEvent,
  recipient: string,
): string {
  return `incident/${incidentId}/${event}/${recipientHash(recipient)}`;
}

export function testNotificationKey(testId: string, recipient: string): string {
  return `test/${testId}/${recipientHash(recipient)}`;
}
