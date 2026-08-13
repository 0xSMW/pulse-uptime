import { createHash, createHmac, timingSafeEqual } from "node:crypto"

export const PORKBUN_REPLAY_WINDOW_SECONDS = 300
export const PORKBUN_MAX_WEBHOOK_BODY_BYTES = 64 * 1024

const domainEvents = new Set(["domain.renewed", "domain.expiring"])
const supportedEvents = new Set([...domainEvents, "webhook.test"])

export type PorkbunDomainEvent = "domain.renewed" | "domain.expiring"

export type PorkbunWebhookEvent = PorkbunDomainEvent | "webhook.test"

export interface PorkbunWebhookRecord {
  domain: string | null
  event: PorkbunWebhookEvent
  eventId: string
  eventCreatedAt: string
  expireDate: string | null
  payloadDigest: string
}

/**
 * The implementation must make this operation durable before returning `new`.
 * Duplicate deliveries must return `duplicate` without creating another record.
 */
export interface PorkbunWebhookPersistence {
  record: (record: PorkbunWebhookRecord) => Promise<{ duplicate: boolean }>
}

export interface PorkbunWebhookReceiverDependencies {
  now?: () => Date
  persistence: PorkbunWebhookPersistence
  signingSecret: string | undefined
}

interface PorkbunWebhookEnvelope {
  createdAt: string
  data: Record<string, unknown>
  event: string
  id: string
}

interface Rejection {
  message: string
  status: number
}

function reject(message: string, status = 400): Rejection {
  return { message, status }
}

function response(status: number, body?: Record<string, string>): Response {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: { "cache-control": "no-store" },
  })
}

function invalidRequestResponse(): Response {
  return response(400, { error: "Invalid webhook request" })
}

function header(request: Request, name: string): string | null {
  const value = request.headers.get(name)
  return value?.trim() || null
}

/**
 * Rejects malformed webhook metadata without requiring the database-backed
 * signing secret. Signature verification and body parsing remain in the
 * receiver after this admission check.
 */
export function admitPorkbunWebhookRequest(
  request: Request,
  now: Date = new Date()
): Response | null {
  const timestamp = header(request, "x-porkbun-webhook-timestamp")
  const signature = header(request, "x-porkbun-signature")
  const webhookId = header(request, "x-porkbun-webhook-id")
  const eventHeader = header(request, "x-porkbun-event")
  if (!(timestamp && signature && webhookId && eventHeader)) {
    return invalidRequestResponse()
  }
  if (
    !(
      /^\d{1,16}$/.test(timestamp) && /^sha256=[a-f\d]{64}$/i.test(signature)
    ) ||
    webhookId.length > 256 ||
    !supportedEvents.has(eventHeader)
  ) {
    return invalidRequestResponse()
  }

  const signedAt = Number(timestamp)
  const nowSeconds = Math.floor(now.getTime() / 1000)
  if (
    !Number.isSafeInteger(signedAt) ||
    Math.abs(nowSeconds - signedAt) > PORKBUN_REPLAY_WINDOW_SECONDS
  ) {
    return invalidRequestResponse()
  }

  const contentLength = request.headers.get("content-length")
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      return invalidRequestResponse()
    }
    if (Number(contentLength) > PORKBUN_MAX_WEBHOOK_BODY_BYTES) {
      return response(413, { error: "Webhook payload too large" })
    }
  }
  return null
}

function verifySignature(
  timestamp: string,
  rawBody: Buffer,
  signature: string,
  signingSecret: string
): boolean {
  const expected = `sha256=${createHmac("sha256", signingSecret)
    .update(Buffer.from(`${timestamp}.`))
    .update(rawBody)
    .digest("hex")}`
  const expectedBuffer = Buffer.from(expected)
  const signatureBuffer = Buffer.from(signature)

  return (
    expectedBuffer.length === signatureBuffer.length &&
    timingSafeEqual(expectedBuffer, signatureBuffer)
  )
}

async function readRawBody(request: Request): Promise<Buffer | Rejection> {
  const contentLength = request.headers.get("content-length")
  if (
    contentLength &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > PORKBUN_MAX_WEBHOOK_BODY_BYTES
  ) {
    return reject("Webhook payload too large", 413)
  }

  if (!request.body) {
    return Buffer.alloc(0)
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    async function readNext(): Promise<Buffer | Rejection> {
      const { done, value } = await reader.read()
      if (done) {
        return Buffer.concat(chunks, size)
      }
      size += value.byteLength
      if (size > PORKBUN_MAX_WEBHOOK_BODY_BYTES) {
        await reader.cancel()
        return reject("Webhook payload too large", 413)
      }
      chunks.push(value)
      return readNext()
    }
    return await readNext()
  } finally {
    reader.releaseLock()
  }
}

function isValidCreatedAt(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/.exec(
      value
    )
  if (!match) {
    return false
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return false
  }

  const [, year, month, day, hour, minute, second] = match
  return parsed
    .toISOString()
    .startsWith(`${year}-${month}-${day}T${hour}:${minute}:${second}`)
}

function parseEnvelope(rawBody: Buffer): PorkbunWebhookEnvelope | Rejection {
  let payload: unknown
  try {
    payload = JSON.parse(rawBody.toString("utf8"))
  } catch {
    return reject("Invalid webhook payload")
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return reject("Invalid webhook payload")
  }

  const envelope = payload as Record<string, unknown>
  if (
    typeof envelope.event !== "string" ||
    typeof envelope.id !== "string" ||
    typeof envelope.createdAt !== "string" ||
    !isValidCreatedAt(envelope.createdAt) ||
    !envelope.data ||
    typeof envelope.data !== "object" ||
    Array.isArray(envelope.data)
  ) {
    return reject("Invalid webhook payload")
  }

  return {
    event: envelope.event,
    id: envelope.id,
    createdAt: envelope.createdAt,
    data: envelope.data as Record<string, unknown>,
  }
}

function recordForEnvelope(
  envelope: PorkbunWebhookEnvelope,
  rawBody: Buffer
): PorkbunWebhookRecord | Rejection {
  if (envelope.event === "webhook.test") {
    return {
      domain: null,
      event: envelope.event,
      eventCreatedAt: envelope.createdAt,
      eventId: envelope.id,
      expireDate: null,
      payloadDigest: createHash("sha256").update(rawBody).digest("hex"),
    }
  }

  const domain = envelope.data.domain
  if (typeof domain !== "string" || !domain.trim()) {
    return reject("Invalid domain event")
  }

  const expireDate = envelope.data.expireDate
  if (expireDate !== undefined && typeof expireDate !== "string") {
    return reject("Invalid domain event")
  }

  return {
    domain: domain.trim().toLowerCase(),
    event: envelope.event as PorkbunDomainEvent,
    eventId: envelope.id,
    eventCreatedAt: envelope.createdAt,
    expireDate: expireDate ?? null,
    payloadDigest: createHash("sha256").update(rawBody).digest("hex"),
  }
}

export async function receivePorkbunWebhook(
  request: Request,
  dependencies: PorkbunWebhookReceiverDependencies
): Promise<Response> {
  const signingSecret = dependencies.signingSecret?.trim()
  if (!signingSecret) {
    return response(503, { error: "Webhook receiver unavailable" })
  }

  const admission = admitPorkbunWebhookRequest(
    request,
    dependencies.now?.() ?? new Date()
  )
  if (admission) {
    return admission
  }

  const timestamp = header(request, "x-porkbun-webhook-timestamp")
  const signature = header(request, "x-porkbun-signature")
  const webhookId = header(request, "x-porkbun-webhook-id")
  const eventHeader = header(request, "x-porkbun-event")
  if (!(timestamp && signature && webhookId && eventHeader)) {
    return invalidRequestResponse()
  }

  const rawBody = await readRawBody(request)
  if ("status" in rawBody) {
    return response(rawBody.status, { error: rawBody.message })
  }
  if (!verifySignature(timestamp, rawBody, signature, signingSecret)) {
    return invalidRequestResponse()
  }

  const envelope = parseEnvelope(rawBody)
  if ("status" in envelope) {
    return response(envelope.status, { error: envelope.message })
  }

  if (
    envelope.id !== webhookId ||
    envelope.event !== eventHeader ||
    !supportedEvents.has(envelope.event)
  ) {
    return invalidRequestResponse()
  }

  try {
    const record = recordForEnvelope(envelope, rawBody)
    if ("status" in record) {
      return response(record.status, { error: record.message })
    }
    const result = await dependencies.persistence.record(record)

    return response(result.duplicate ? 200 : 204)
  } catch {
    console.error("Porkbun webhook processing failed", {
      errorCode: "webhook_persistence_failed",
    })
    return response(500, { error: "Webhook processing failed" })
  }
}
