import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto"

import { and, eq, isNull, sql } from "drizzle-orm"

import { type DatabaseHandle, db } from "@/lib/db/client"
import { porkbunIntegration, porkbunWebhookReceipts } from "@/lib/db/schema"

import type {
  PorkbunWebhookPersistence,
  PorkbunWebhookRecord,
} from "./receiver"

const INTEGRATION_ID = "default"
const CIPHERTEXT_VERSION = "v1"
const CLAIM_LIMIT_MAX = 100

export interface PorkbunIntegrationState {
  coveredDomainCount: number
  expiryAlertsEnabled: boolean
  providerCheckedAt: Date | null
  providerLastErrorCode: string | null
  providerLastSuccessAt: Date | null
  webhookId: number | null
  webhookLastReceivedAt: Date | null
  webhookStatus: "ACTIVE" | "DISABLED" | "FAILING" | null
  webhookUrl: string | null
}

export interface PorkbunIntegrationUpdate {
  coveredDomainCount?: number
  expiryAlertsEnabled?: boolean
  providerCheckedAt?: Date | null
  providerLastErrorCode?: string | null
  providerLastSuccessAt?: Date | null
  webhookId?: number | null
  webhookSecret?: string | null
  webhookStatus?: "ACTIVE" | "DISABLED" | "FAILING" | null
  webhookUrl?: string | null
}

export interface ClaimedPorkbunWebhookReceipt extends PorkbunWebhookRecord {
  attemptCount: number
  processingStartedAt: Date
  receivedAt: Date
}

export class PorkbunWebhookReplayMismatchError extends Error {
  constructor() {
    super("Porkbun webhook event ID was replayed with a different payload")
    this.name = "PorkbunWebhookReplayMismatchError"
  }
}

function encryptionKey(hashKey = process.env.API_TOKEN_HASH_KEY): Buffer {
  if (!hashKey || hashKey.length < 32) {
    throw new Error("API_TOKEN_HASH_KEY must contain at least 32 characters")
  }
  return createHash("sha256")
    .update("pulse-porkbun-webhook-secret-v1\0", "utf8")
    .update(hashKey, "utf8")
    .digest()
}

/** Encrypts a webhook secret for the singleton integration row. */
export function encryptPorkbunWebhookSecret(
  secret: string,
  hashKey?: string
): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(hashKey), iv)
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ])
  return [
    CIPHERTEXT_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":")
}

/** Decrypts the versioned ciphertext stored for the singleton integration. */
export function decryptPorkbunWebhookSecret(
  encrypted: string,
  hashKey?: string
): string {
  const [version, ivEncoded, tagEncoded, ciphertextEncoded, ...extra] =
    encrypted.split(":")
  if (
    version !== CIPHERTEXT_VERSION ||
    !ivEncoded ||
    !tagEncoded ||
    !ciphertextEncoded ||
    extra.length > 0
  ) {
    throw new Error("Invalid Porkbun webhook secret ciphertext")
  }

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(hashKey),
      Buffer.from(ivEncoded, "base64url")
    )
    decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"))
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
      decipher.final(),
    ]).toString("utf8")
  } catch (error) {
    throw new Error("Invalid Porkbun webhook secret ciphertext", {
      cause: error,
    })
  }
}

function stateFromRow(
  row: typeof porkbunIntegration.$inferSelect
): PorkbunIntegrationState {
  return {
    coveredDomainCount: row.coveredDomainCount,
    expiryAlertsEnabled: row.expiryAlertsEnabled,
    providerCheckedAt: row.providerCheckedAt,
    providerLastErrorCode: row.providerLastErrorCode,
    providerLastSuccessAt: row.providerLastSuccessAt,
    webhookId: row.webhookId,
    webhookLastReceivedAt: row.webhookLastReceivedAt,
    webhookStatus: row.webhookStatus,
    webhookUrl: row.webhookUrl,
  }
}

export async function readPorkbunIntegration(
  handle: DatabaseHandle = db
): Promise<PorkbunIntegrationState | null> {
  const [row] = await handle
    .select()
    .from(porkbunIntegration)
    .where(eq(porkbunIntegration.id, INTEGRATION_ID))
    .limit(1)
  return row ? stateFromRow(row) : null
}

/** Returns the server-only signing secret, never an integration state object. */
export async function readPorkbunWebhookSigningSecret(
  handle: DatabaseHandle = db
): Promise<string | null> {
  const [row] = await handle
    .select({ encrypted: porkbunIntegration.webhookSecretEncrypted })
    .from(porkbunIntegration)
    .where(eq(porkbunIntegration.id, INTEGRATION_ID))
    .limit(1)
  return row?.encrypted ? decryptPorkbunWebhookSecret(row.encrypted) : null
}

export async function upsertPorkbunIntegration(
  update: PorkbunIntegrationUpdate,
  options: { handle?: DatabaseHandle; now?: Date } = {}
): Promise<PorkbunIntegrationState> {
  if (
    (update.webhookId === undefined) !==
    (update.webhookSecret === undefined)
  ) {
    throw new Error("Porkbun webhook ID and secret must be updated together")
  }
  const now = options.now ?? new Date()
  const secretEncrypted =
    update.webhookSecret === undefined
      ? undefined
      : update.webhookSecret === null
        ? null
        : encryptPorkbunWebhookSecret(update.webhookSecret)
  const values = {
    ...update,
    webhookSecret: undefined,
    webhookSecretEncrypted: secretEncrypted,
    id: INTEGRATION_ID,
    createdAt: now,
    updatedAt: now,
  }
  const { webhookSecret: _webhookSecret, ...insertValues } = values
  const set = Object.fromEntries(
    Object.entries({
      ...update,
      webhookSecretEncrypted: secretEncrypted,
      updatedAt: now,
    }).filter(([, value]) => value !== undefined)
  )
  delete (set as Record<string, unknown>).webhookSecret

  const [row] = await (options.handle ?? db)
    .insert(porkbunIntegration)
    .values(insertValues)
    .onConflictDoUpdate({ target: porkbunIntegration.id, set })
    .returning()
  if (!row) {
    throw new Error("Failed to persist Porkbun integration")
  }
  return stateFromRow(row)
}

/** Durable receiver persistence with replay conflict detection. */
export class PorkbunWebhookStore implements PorkbunWebhookPersistence {
  constructor(
    private readonly handle: DatabaseHandle = db,
    private readonly now: () => Date = () => new Date()
  ) {}

  async record(record: PorkbunWebhookRecord): Promise<{ duplicate: boolean }> {
    const [inserted] = await this.handle
      .insert(porkbunWebhookReceipts)
      .values({
        eventId: record.eventId,
        eventType: record.event,
        apexDomain: record.domain,
        expireDate: record.expireDate,
        payloadDigest: record.payloadDigest,
        providerCreatedAt: new Date(record.eventCreatedAt),
        receivedAt: this.now(),
      })
      .onConflictDoNothing({ target: porkbunWebhookReceipts.eventId })
      .returning({ eventId: porkbunWebhookReceipts.eventId })

    if (inserted) {
      return { duplicate: false }
    }
    const [existing] = await this.handle
      .select({ payloadDigest: porkbunWebhookReceipts.payloadDigest })
      .from(porkbunWebhookReceipts)
      .where(eq(porkbunWebhookReceipts.eventId, record.eventId))
      .limit(1)
    if (!existing || existing.payloadDigest !== record.payloadDigest) {
      throw new PorkbunWebhookReplayMismatchError()
    }
    return { duplicate: true }
  }
}

function claimedDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) {
    throw new Error("Porkbun webhook claim returned an invalid timestamp")
  }
  return date
}

/**
 * Claims the oldest pending receipts with SKIP LOCKED. A stale claim can be
 * reclaimed after `staleBefore`, making failures and crashed cron runs retryable.
 */
export async function claimPendingPorkbunWebhookReceipts(
  input: { limit: number; now?: Date; staleBefore: Date },
  handle: DatabaseHandle = db
): Promise<ClaimedPorkbunWebhookReceipt[]> {
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > CLAIM_LIMIT_MAX
  ) {
    throw new Error(
      `Porkbun webhook claim limit must be between 1 and ${CLAIM_LIMIT_MAX}`
    )
  }
  const now = input.now ?? new Date()
  const staleBeforeIso = input.staleBefore.toISOString()
  const nowIso = now.toISOString()
  const result = await handle.execute(sql`
    with candidates as (
      select event_id
      from porkbun_webhook_receipts
      where processed_at is null
        and (
          processing_started_at is null
          or processing_started_at < ${staleBeforeIso}::timestamptz
        )
      order by received_at asc
      limit ${input.limit}
      for update skip locked
    )
    update porkbun_webhook_receipts as receipt
    set processing_started_at = ${nowIso}::timestamptz,
        attempt_count = receipt.attempt_count + 1,
        last_error_code = null
    from candidates
    where receipt.event_id = candidates.event_id
    returning receipt.event_id, receipt.event_type, receipt.apex_domain,
      receipt.expire_date, receipt.provider_created_at, receipt.payload_digest,
      receipt.received_at, receipt.processing_started_at, receipt.attempt_count
  `)
  return (result as unknown as Record<string, unknown>[]).map((row) => ({
    event: row.event_type as PorkbunWebhookRecord["event"],
    eventCreatedAt: claimedDate(row.provider_created_at).toISOString(),
    eventId: row.event_id as string,
    domain: row.apex_domain as string | null,
    expireDate: row.expire_date as string | null,
    payloadDigest: row.payload_digest as string,
    receivedAt: claimedDate(row.received_at),
    processingStartedAt: claimedDate(row.processing_started_at),
    attemptCount: row.attempt_count as number,
  }))
}

export async function markPorkbunWebhookReceiptProcessed(
  receipt: Pick<
    ClaimedPorkbunWebhookReceipt,
    "attemptCount" | "eventId" | "processingStartedAt"
  >,
  options: { handle?: DatabaseHandle; now?: Date } = {}
): Promise<boolean> {
  const rows = await (options.handle ?? db)
    .update(porkbunWebhookReceipts)
    .set({ processedAt: options.now ?? new Date(), lastErrorCode: null })
    .where(
      and(
        eq(porkbunWebhookReceipts.eventId, receipt.eventId),
        eq(porkbunWebhookReceipts.attemptCount, receipt.attemptCount),
        eq(
          porkbunWebhookReceipts.processingStartedAt,
          receipt.processingStartedAt
        ),
        isNull(porkbunWebhookReceipts.processedAt)
      )
    )
    .returning({ eventId: porkbunWebhookReceipts.eventId })
  return rows.length === 1
}

export async function markPorkbunWebhookReceiptFailed(
  receipt: Pick<
    ClaimedPorkbunWebhookReceipt,
    "attemptCount" | "eventId" | "processingStartedAt"
  >,
  errorCode: string,
  handle: DatabaseHandle = db
): Promise<boolean> {
  const rows = await handle
    .update(porkbunWebhookReceipts)
    .set({ lastErrorCode: errorCode, processingStartedAt: null })
    .where(
      and(
        eq(porkbunWebhookReceipts.eventId, receipt.eventId),
        eq(porkbunWebhookReceipts.attemptCount, receipt.attemptCount),
        eq(
          porkbunWebhookReceipts.processingStartedAt,
          receipt.processingStartedAt
        ),
        isNull(porkbunWebhookReceipts.processedAt)
      )
    )
    .returning({ eventId: porkbunWebhookReceipts.eventId })
  return rows.length === 1
}

export async function notePorkbunWebhookReceived(
  options: { handle?: DatabaseHandle; now?: Date } = {}
): Promise<void> {
  const now = options.now ?? new Date()
  await (options.handle ?? db)
    .insert(porkbunIntegration)
    .values({
      id: INTEGRATION_ID,
      createdAt: now,
      updatedAt: now,
      webhookLastReceivedAt: now,
    })
    .onConflictDoUpdate({
      target: porkbunIntegration.id,
      set: { updatedAt: now, webhookLastReceivedAt: now },
    })
}
