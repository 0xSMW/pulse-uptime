import "server-only"

import { randomUUID } from "node:crypto"

const PORKBUN_API_URL = "https://api.porkbun.com/api/json/v3"
const PORKBUN_TIMEOUT_MS = 10_000
const PORKBUN_MAX_BODY_BYTES = 1024 * 1024

export const PORKBUN_DOMAIN_WEBHOOK_EVENTS = [
  "domain.renewed",
  "domain.expiring",
] as const

export type PorkbunDomainWebhookEvent =
  (typeof PORKBUN_DOMAIN_WEBHOOK_EVENTS)[number]
export type PorkbunWebhookStatus = "ACTIVE" | "DISABLED"
export type PorkbunDeliveryStatus =
  | "PENDING"
  | "PROCESSING"
  | "DELIVERED"
  | "FAILED"

export interface PorkbunWebhookEndpoint {
  id: number
  url: string
  secret: string
  events: string[]
  status: PorkbunWebhookStatus
  consecutiveFailures: number | null
  lastSuccessDate: string | null
  lastFailureDate: string | null
  lastError: string | null
  createDate: string | null
}

export interface PorkbunWebhookDelivery {
  id: number
  endpointId: number
  eventType: string
  eventId: string
  status: PorkbunDeliveryStatus
  attempts: number | null
  maxAttempts: number | null
  httpStatus: number | null
  lastError: string | null
  nextAttemptAt: string | null
  createDate: string | null
  deliveredDate: string | null
}

export interface PorkbunWebhookDeliveryHealth {
  endpoint: PorkbunWebhookEndpoint
  deliveries: PorkbunWebhookDelivery[]
  total: number
}

export type PorkbunWebhookFailureReason =
  | "network"
  | "timeout"
  | "http"
  | "malformed-response"
  | "oversized-response"

export type PorkbunWebhookResult<T> =
  | { outcome: "ok"; data: T; requestId: string | null }
  | { outcome: "unconfigured" }
  | { outcome: "rate-limited"; retryAt: Date | null; requestId: string | null }
  | {
      outcome: "failed"
      reason: PorkbunWebhookFailureReason
      code: string | null
      httpStatus: number | null
      requestId: string | null
    }

export type PorkbunWebhookFetcher = (
  input: string,
  init: RequestInit
) => Promise<Response>

export interface PorkbunWebhookClientOptions {
  env?: Partial<
    Pick<NodeJS.ProcessEnv, "PORKBUN_API_KEY" | "PORKBUN_SECRET_KEY">
  >
  fetcher?: PorkbunWebhookFetcher
  idempotencyKey?: () => string
}

export interface UpdatePorkbunDomainWebhookInput {
  id: number
  status?: PorkbunWebhookStatus
  url?: string
}

interface PorkbunEndpointDocument {
  consecutiveFailures?: unknown
  createDate?: unknown
  events?: unknown
  id?: unknown
  lastError?: unknown
  lastFailureDate?: unknown
  lastSuccessDate?: unknown
  secret?: unknown
  status?: unknown
  url?: unknown
}

interface PorkbunDeliveryDocument {
  attempts?: unknown
  createDate?: unknown
  deliveredDate?: unknown
  endpointId?: unknown
  eventId?: unknown
  eventType?: unknown
  httpStatus?: unknown
  id?: unknown
  lastError?: unknown
  maxAttempts?: unknown
  nextAttemptAt?: unknown
  status?: unknown
}

interface PorkbunErrorDocument {
  code?: unknown
  status?: unknown
}

function credential(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed || null
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function parseEndpoint(value: unknown): PorkbunWebhookEndpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  const endpoint = value as PorkbunEndpointDocument
  const id = optionalNumber(endpoint.id)
  const url = optionalString(endpoint.url)
  const secret = optionalString(endpoint.secret)
  const status = optionalString(endpoint.status)
  if (
    id === null ||
    !Number.isInteger(id) ||
    !url ||
    !secret ||
    (status !== "ACTIVE" && status !== "DISABLED") ||
    !Array.isArray(endpoint.events) ||
    endpoint.events.some((event) => typeof event !== "string")
  ) {
    return null
  }
  return {
    id,
    url,
    secret,
    events: endpoint.events,
    status,
    consecutiveFailures: optionalNumber(endpoint.consecutiveFailures),
    lastSuccessDate: optionalString(endpoint.lastSuccessDate),
    lastFailureDate: optionalString(endpoint.lastFailureDate),
    lastError: optionalString(endpoint.lastError),
    createDate: optionalString(endpoint.createDate),
  }
}

function parseDelivery(value: unknown): PorkbunWebhookDelivery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  const delivery = value as PorkbunDeliveryDocument
  const id = optionalNumber(delivery.id)
  const endpointId = optionalNumber(delivery.endpointId)
  const eventType = optionalString(delivery.eventType)
  const eventId = optionalString(delivery.eventId)
  const status = optionalString(delivery.status)
  if (
    id === null ||
    endpointId === null ||
    !Number.isInteger(id) ||
    !Number.isInteger(endpointId) ||
    !eventType ||
    !eventId ||
    !(
      status === "PENDING" ||
      status === "PROCESSING" ||
      status === "DELIVERED" ||
      status === "FAILED"
    )
  ) {
    return null
  }
  return {
    id,
    endpointId,
    eventType,
    eventId,
    status,
    attempts: optionalNumber(delivery.attempts),
    maxAttempts: optionalNumber(delivery.maxAttempts),
    httpStatus: optionalNumber(delivery.httpStatus),
    lastError: optionalString(delivery.lastError),
    nextAttemptAt: optionalString(delivery.nextAttemptAt),
    createDate: optionalString(delivery.createDate),
    deliveredDate: optionalString(delivery.deliveredDate),
  }
}

function parseRetryAt(response: Response): Date | null {
  const reset = response.headers.get("x-ratelimit-reset")
  if (!reset) {
    return null
  }
  const seconds = Number(reset)
  const date = Number.isFinite(seconds)
    ? new Date(seconds * 1000)
    : new Date(reset)
  return Number.isNaN(date.getTime()) ? null : date
}

function classifyTransportError(error: unknown): "network" | "timeout" {
  return error instanceof DOMException && error.name === "TimeoutError"
    ? "timeout"
    : "network"
}

async function readCappedBody(response: Response): Promise<string | null> {
  const length = Number(response.headers.get("content-length"))
  if (Number.isFinite(length) && length > PORKBUN_MAX_BODY_BYTES) {
    return null
  }
  if (!response.body) {
    const text = await response.text()
    return Buffer.byteLength(text, "utf8") <= PORKBUN_MAX_BODY_BYTES
      ? text
      : null
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.byteLength
      if (size > PORKBUN_MAX_BODY_BYTES) {
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

function httpsUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === "https:" ? url.toString() : null
  } catch {
    return null
  }
}

export class PorkbunWebhookClient {
  private readonly apiKey: string | null
  private readonly fetcher: PorkbunWebhookFetcher
  private readonly idempotencyKey: () => string
  private readonly secretKey: string | null

  constructor(options: PorkbunWebhookClientOptions = {}) {
    const env = options.env ?? process.env
    this.apiKey = credential(env.PORKBUN_API_KEY)
    this.secretKey = credential(env.PORKBUN_SECRET_KEY)
    this.fetcher = options.fetcher ?? fetch
    this.idempotencyKey = options.idempotencyKey ?? randomUUID
  }

  async listEndpoints(): Promise<
    PorkbunWebhookResult<PorkbunWebhookEndpoint[]>
  > {
    return this.request("/webhook/list", "GET", undefined, (document) => {
      if (
        !document ||
        typeof document !== "object" ||
        (document as { status?: unknown }).status !== "SUCCESS" ||
        !Array.isArray((document as { endpoints?: unknown }).endpoints)
      ) {
        return null
      }
      const endpoints = (document as { endpoints: unknown[] }).endpoints.map(
        parseEndpoint
      )
      return endpoints.every((endpoint) => endpoint !== null)
        ? (endpoints as PorkbunWebhookEndpoint[])
        : null
    })
  }

  async createEndpoint(
    url: string
  ): Promise<PorkbunWebhookResult<PorkbunWebhookEndpoint>> {
    const normalizedUrl = httpsUrl(url)
    if (!normalizedUrl) {
      return {
        outcome: "failed",
        reason: "http",
        code: "INVALID_WEBHOOK_URL",
        httpStatus: null,
        requestId: null,
      }
    }
    return this.request(
      "/webhook/create",
      "POST",
      {
        events: PORKBUN_DOMAIN_WEBHOOK_EVENTS,
        url: normalizedUrl,
      },
      parseEndpointResponse
    )
  }

  async updateEndpoint(
    input: UpdatePorkbunDomainWebhookInput
  ): Promise<PorkbunWebhookResult<PorkbunWebhookEndpoint>> {
    if (!isPositiveInteger(input.id)) {
      return {
        outcome: "failed",
        reason: "http",
        code: "INVALID_WEBHOOK_ID",
        httpStatus: null,
        requestId: null,
      }
    }
    const url = input.url === undefined ? undefined : httpsUrl(input.url)
    if (input.url !== undefined && !url) {
      return {
        outcome: "failed",
        reason: "http",
        code: "INVALID_WEBHOOK_URL",
        httpStatus: null,
        requestId: null,
      }
    }
    return this.request(
      "/webhook/update",
      "POST",
      {
        events: PORKBUN_DOMAIN_WEBHOOK_EVENTS,
        id: input.id,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(url === undefined ? {} : { url }),
      },
      parseEndpointResponse
    )
  }

  async testEndpoint(
    id: number
  ): Promise<PorkbunWebhookResult<{ eventId: string }>> {
    if (!isPositiveInteger(id)) {
      return {
        outcome: "failed",
        reason: "http",
        code: "INVALID_WEBHOOK_ID",
        httpStatus: null,
        requestId: null,
      }
    }
    return this.request("/webhook/test", "POST", { id }, (document) => {
      if (!document || typeof document !== "object") {
        return null
      }
      const response = document as { eventId?: unknown; status?: unknown }
      return response.status === "SUCCESS" &&
        typeof response.eventId === "string"
        ? { eventId: response.eventId }
        : null
    })
  }

  async inspectDeliveryHealth(
    id: number
  ): Promise<PorkbunWebhookResult<PorkbunWebhookDeliveryHealth>> {
    if (!isPositiveInteger(id)) {
      return {
        outcome: "failed",
        reason: "http",
        code: "INVALID_WEBHOOK_ID",
        httpStatus: null,
        requestId: null,
      }
    }
    const endpoint = await this.request(
      `/webhook/get/${id}`,
      "GET",
      undefined,
      parseEndpointResponse
    )
    if (endpoint.outcome !== "ok") {
      return endpoint
    }
    const deliveries = await this.request(
      `/webhook/deliveries?endpointId=${id}&limit=50`,
      "GET",
      undefined,
      parseDeliveryListResponse
    )
    if (deliveries.outcome !== "ok") {
      return deliveries
    }
    return {
      outcome: "ok",
      data: { endpoint: endpoint.data, ...deliveries.data },
      requestId: deliveries.requestId,
    }
  }

  private async request<T>(
    path: string,
    method: "GET" | "POST",
    body: Record<string, unknown> | undefined,
    parse: (document: unknown) => T | null
  ): Promise<PorkbunWebhookResult<T>> {
    if (!(this.apiKey && this.secretKey)) {
      return { outcome: "unconfigured" }
    }
    let response: Response
    try {
      response = await this.fetcher(`${PORKBUN_API_URL}${path}`, {
        method,
        headers: {
          accept: "application/json",
          ...(method === "POST"
            ? {
                "content-type": "application/json",
                "Idempotency-Key": this.idempotencyKey(),
              }
            : {}),
          "X-API-Key": this.apiKey,
          "X-Secret-API-Key": this.secretKey,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(PORKBUN_TIMEOUT_MS),
      })
    } catch (error) {
      return {
        outcome: "failed",
        reason: classifyTransportError(error),
        code: null,
        httpStatus: null,
        requestId: null,
      }
    }

    const requestId = response.headers.get("x-request-id")
    let text: string | null
    try {
      text = await readCappedBody(response)
    } catch (error) {
      return {
        outcome: "failed",
        reason: classifyTransportError(error),
        code: null,
        httpStatus: response.status,
        requestId,
      }
    }
    if (text === null) {
      return {
        outcome: "failed",
        reason: "oversized-response",
        code: null,
        httpStatus: response.status,
        requestId,
      }
    }
    let document: unknown
    try {
      document = JSON.parse(text)
    } catch {
      return {
        outcome: "failed",
        reason: "malformed-response",
        code: null,
        httpStatus: response.status,
        requestId,
      }
    }
    if (response.status === 429) {
      return {
        outcome: "rate-limited",
        retryAt: parseRetryAt(response),
        requestId,
      }
    }
    if (!response.ok) {
      const code = optionalString(
        (document as PorkbunErrorDocument | null)?.code
      )
      return {
        outcome: "failed",
        reason: "http",
        code,
        httpStatus: response.status,
        requestId,
      }
    }
    const data = parse(document)
    return data === null
      ? {
          outcome: "failed",
          reason: "malformed-response",
          code: null,
          httpStatus: response.status,
          requestId,
        }
      : { outcome: "ok", data, requestId }
  }
}

function parseEndpointResponse(
  document: unknown
): PorkbunWebhookEndpoint | null {
  if (!document || typeof document !== "object") {
    return null
  }
  const response = document as { endpoint?: unknown; status?: unknown }
  return response.status === "SUCCESS" ? parseEndpoint(response.endpoint) : null
}

function parseDeliveryListResponse(
  document: unknown
): { deliveries: PorkbunWebhookDelivery[]; total: number } | null {
  if (!document || typeof document !== "object") {
    return null
  }
  const response = document as {
    deliveries?: unknown
    status?: unknown
    total?: unknown
  }
  if (response.status !== "SUCCESS" || !Array.isArray(response.deliveries)) {
    return null
  }
  const deliveries = response.deliveries.map(parseDelivery)
  const total = optionalNumber(response.total)
  return deliveries.every((delivery) => delivery !== null) && total !== null
    ? { deliveries: deliveries as PorkbunWebhookDelivery[], total }
    : null
}
