import { createHash } from "node:crypto"

export const DOMAIN_EXPIRY_ALERT_THRESHOLDS = [30, 14] as const

export type DomainExpiryAlertThreshold =
  (typeof DOMAIN_EXPIRY_ALERT_THRESHOLDS)[number]

/** Optional alerting stays off until an administrator enables it. */
export interface DomainExpiryAlertSettings {
  enabled?: boolean
}

/** A successful Porkbun registration fact. Certificate facts are deliberately absent. */
export interface DomainRegistrationExpiry {
  apexDomain: string
  expiresAt: Date | null
  /** Informational Porkbun context. Automatic renewal never suppresses an alert. */
  autoRenew: boolean | null
}

/**
 * Payload consumed by the notification type and email renderer.
 * It contains all domain facts necessary to render an alert without another
 * lookup, including auto-renew as context only.
 */
export interface DomainExpiryAlertPayload {
  type: "domain.expiry"
  apexDomain: string
  expiresAt: string
  thresholdDays: DomainExpiryAlertThreshold
  autoRenew: boolean | null
}

/**
 * The complete insert contract for the existing notification outbox.
 * The runtime adapter owns mapping this structural type to its shared schema.
 */
export interface DomainExpiryOutboxRow {
  id: string
  eventType: "domain.expiry"
  recipient: string
  idempotencyKey: string
  payload: DomainExpiryAlertPayload
  status: "pending"
  attemptCount: 0
  nextAttemptAt: Date
  createdAt: Date
  updatedAt: Date
}

export interface BuildDomainExpiryAlertsInput {
  settings?: DomainExpiryAlertSettings
  registrations: readonly DomainRegistrationExpiry[]
  /** Only global default recipients receive domain-expiry alerts. */
  defaultRecipients: readonly string[]
  now: Date
  createId: () => string
}

export type DomainExpiryOutboxEnqueuer = (
  rows: readonly DomainExpiryOutboxRow[]
) => Promise<number>

function normalizeApexDomain(apexDomain: string): string {
  return apexDomain.trim().toLowerCase()
}

function normalizeRecipients(recipients: readonly string[]): string[] {
  return [
    ...new Set(
      recipients
        .map((recipient) => recipient.trim().toLowerCase())
        .filter((recipient) => recipient.length > 0)
    ),
  ]
}

function recipientHash(recipient: string): string {
  return createHash("sha256").update(recipient).digest("hex")
}

/**
 * Stable deduplication identity for one apex, observed expiry instant,
 * threshold, and recipient. A renewed expiry instant therefore starts a new
 * alert cycle, while repeated collection runs cannot enqueue a duplicate.
 */
export function domainExpiryAlertKey(
  apexDomain: string,
  expiresAt: Date,
  thresholdDays: DomainExpiryAlertThreshold,
  recipient: string
): string {
  return `domain-expiry/${encodeURIComponent(normalizeApexDomain(apexDomain))}/${expiresAt.toISOString()}/${thresholdDays}/${recipientHash(recipient.trim().toLowerCase())}`
}

function reachedThreshold(
  expiresAt: Date,
  now: Date
): DomainExpiryAlertThreshold | null {
  const remainingMs = expiresAt.getTime() - now.getTime()
  if (remainingMs <= 14 * 86_400_000) {
    return 14
  }
  if (remainingMs <= 30 * 86_400_000) {
    return 30
  }
  return null
}

/**
 * Builds pending outbox rows without touching persistence. Alerts are disabled
 * unless settings.enabled is exactly true. Each qualifying registration emits
 * once for its nearest reached threshold and each default recipient. A fact
 * first observed below 14 days therefore does not backfill a 30-day alert.
 * autoRenew is preserved in the payload, never used as a suppression condition.
 */
export function buildDomainExpiryAlertRows(
  input: BuildDomainExpiryAlertsInput
): DomainExpiryOutboxRow[] {
  if (input.settings?.enabled !== true) {
    return []
  }

  const recipients = normalizeRecipients(input.defaultRecipients)
  if (recipients.length === 0) {
    return []
  }

  const rows: DomainExpiryOutboxRow[] = []
  for (const registration of input.registrations) {
    const apexDomain = normalizeApexDomain(registration.apexDomain)
    const expiresAt = registration.expiresAt
    if (
      apexDomain.length === 0 ||
      expiresAt === null ||
      Number.isNaN(expiresAt.getTime())
    ) {
      continue
    }

    const thresholdDays = reachedThreshold(expiresAt, input.now)
    if (thresholdDays === null) {
      continue
    }
    const payload: DomainExpiryAlertPayload = {
      type: "domain.expiry",
      apexDomain,
      expiresAt: expiresAt.toISOString(),
      thresholdDays,
      autoRenew: registration.autoRenew,
    }
    for (const recipient of recipients) {
      rows.push({
        id: input.createId(),
        eventType: "domain.expiry",
        recipient,
        idempotencyKey: domainExpiryAlertKey(
          apexDomain,
          expiresAt,
          thresholdDays,
          recipient
        ),
        payload,
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      })
    }
  }
  return rows
}

/**
 * Persists only rows the pure policy selected. The injected writer lets the
 * domain-health coordinator retain its own transaction and conflict handling.
 */
export async function enqueueDomainExpiryAlerts(
  input: BuildDomainExpiryAlertsInput,
  enqueue: DomainExpiryOutboxEnqueuer
): Promise<number> {
  const rows = buildDomainExpiryAlertRows(input)
  return rows.length === 0 ? 0 : enqueue(rows)
}
