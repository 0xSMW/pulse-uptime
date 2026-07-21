import { createHash } from "node:crypto"

export type IncidentNotificationEvent = "opened" | "resolved"

export function normalizeRecipient(recipient: string): string {
  return recipient.trim().toLowerCase()
}

export function recipientHash(recipient: string): string {
  return createHash("sha256")
    .update(normalizeRecipient(recipient))
    .digest("hex")
}

export function incidentNotificationKey(
  incidentId: string,
  event: IncidentNotificationEvent,
  recipient: string
): string {
  return `incident/${incidentId}/${event}/${recipientHash(recipient)}`
}

export function testNotificationKey(testId: string, recipient: string): string {
  return `test/${testId}/${recipientHash(recipient)}`
}

/**
 * Dedup key for a system self-alert. The bucket (for example an hour stamp)
 * bounds the alert cadence: while a fault persists across many sweep runs, one
 * mail per kind, bucket, and recipient is enqueued rather than one every sweep.
 */
export function systemAlertKey(
  kind: string,
  bucket: string,
  recipient: string
): string {
  return `system/${kind}/${bucket}/${recipientHash(recipient)}`
}

/** UTC hour stamp (YYYY-MM-DDTHH) used as the default system-alert bucket. */
export function hourBucket(now: Date): string {
  return now.toISOString().slice(0, 13)
}

export type DependencyNotificationEvent = "incident" | "recovery"

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
 *
 * occurrence is an optional trailing component for the same external id
 * recurring across more than one open/resolved cycle (a provider incident
 * that reopens under the same id after a prior resolution). Omitting it
 * keeps the key identical to before this parameter existed, so a first
 * occurrence's already-enqueued row keeps deduplicating unchanged.
 */
export function dependencyNotificationKey(
  sourceId: string,
  incidentExternalId: string,
  catalogId: string,
  scopeId: string | null,
  event: DependencyNotificationEvent,
  recipient: string,
  occurrence?: string
): string {
  const base = `dependency/${sourceId}/${incidentExternalId}/${catalogId}/${scopeId ?? ""}/${event}/${recipientHash(recipient)}`
  return occurrence === undefined ? base : `${base}/${occurrence}`
}
