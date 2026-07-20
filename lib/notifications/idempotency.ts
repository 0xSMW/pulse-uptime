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
 * installed preset, scope, event kind, and recipient. Stable across
 * repeated polls of the same still-open (or still-resolved) incident, so
 * persist.ts can attempt to enqueue on a qualifying transition and rely on
 * this key's uniqueness to send exactly one alert per event.
 *
 * scopeId is required (pass null for an unscoped preset, normalized to
 * empty below) so two scoped installs of the same preset (e.g. two Neon
 * regions) that both match one incident get distinct keys instead of
 * colliding and losing one region's alert.
 */
export function dependencyNotificationKey(
  sourceId: string,
  incidentExternalId: string,
  catalogId: string,
  scopeId: string | null,
  event: DependencyNotificationEvent,
  recipient: string,
): string {
  return `dependency/${sourceId}/${incidentExternalId}/${catalogId}/${scopeId ?? ""}/${event}/${recipientHash(recipient)}`;
}
