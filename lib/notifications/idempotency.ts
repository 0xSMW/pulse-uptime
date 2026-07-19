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

export type DependencyNotificationEvent = "incident" | "recovery";

/**
 * Dedup key for dependency notifications: source, provider incident id,
 * installed preset, event kind, and recipient. Stable across repeated polls
 * of the same still-open (or still-resolved) incident, so persist.ts can
 * attempt to enqueue every cycle and rely on this key's uniqueness to send
 * exactly one alert per qualifying event.
 */
export function dependencyNotificationKey(
  sourceId: string,
  incidentExternalId: string,
  presetId: string,
  event: DependencyNotificationEvent,
  recipient: string,
): string {
  return `dependency/${sourceId}/${incidentExternalId}/${presetId}/${event}/${recipientHash(recipient)}`;
}
