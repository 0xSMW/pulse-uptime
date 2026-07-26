import "server-only"

import { sanitizeDisplayFact } from "./sanitize"

const PORKBUN_LIST_ALL_URL =
  "https://api.porkbun.com/api/json/v3/domain/listAll"
const PORKBUN_TIMEOUT_MS = 10_000
const PORKBUN_MAX_BODY_BYTES = 1024 * 1024
const PORKBUN_PAGE_SIZE = 1000
const PORKBUN_MAX_PAGES = 100

export interface PorkbunDomainRenewalFacts {
  domain: string
  expiresAt: Date | null
  autoRenew: boolean | null
  notLocal: boolean | null
  status: string | null
  apiAccess: boolean | null
}

export type PorkbunDomainLookup =
  | {
      outcome: "resolved"
      domains: PorkbunDomainRenewalFacts[]
    }
  | {
      outcome: "unconfigured" | "rate-limited" | "failed"
      domains: []
      reason?:
        | "network"
        | "timeout"
        | "http"
        | "malformed-response"
        | "oversized-response"
        | "pagination-limit"
      retryAt?: Date | null
    }

export type PorkbunFetcher = (
  input: string,
  init: RequestInit
) => Promise<Response>

export interface PorkbunDomainClientOptions {
  env?: Partial<
    Pick<NodeJS.ProcessEnv, "PORKBUN_API_KEY" | "PORKBUN_SECRET_KEY">
  >
  fetcher?: PorkbunFetcher
}

interface PorkbunListResponse {
  status?: unknown
  domains?: unknown
}

interface PorkbunDomainRecord {
  domain?: unknown
  expireDate?: unknown
  autoRenew?: unknown
  notLocal?: unknown
  status?: unknown
  apiAccess?: unknown
}

function readCredential(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function parseBoolean(value: unknown): boolean | null {
  if (
    value === true ||
    value === 1 ||
    value === "1" ||
    value === "yes" ||
    value === "on"
  ) {
    return true
  }
  if (
    value === false ||
    value === 0 ||
    value === "0" ||
    value === "no" ||
    value === "off"
  ) {
    return false
  }
  return null
}

/**
 * Porkbun returns expiry timestamps as either ISO 8601 or `YYYY-MM-DD HH:mm:ss`.
 * The latter has no offset, so this adapter interprets it as UTC rather than the
 * Vercel region's local time.
 */
export function parsePorkbunExpiry(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null
  }
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}

function parseDomainRecord(value: unknown): PorkbunDomainRenewalFacts | null {
  if (!value || typeof value !== "object") {
    return null
  }
  const record = value as PorkbunDomainRecord
  if (typeof record.domain !== "string" || !record.domain.trim()) {
    return null
  }
  return {
    domain: record.domain.toLowerCase(),
    expiresAt: parsePorkbunExpiry(record.expireDate),
    autoRenew: parseBoolean(record.autoRenew),
    notLocal: parseBoolean(record.notLocal),
    status:
      typeof record.status === "string"
        ? sanitizeDisplayFact(record.status)
        : null,
    apiAccess: parseBoolean(record.apiAccess),
  }
}

async function readCappedBody(response: Response): Promise<string | null> {
  const declaredLength = Number(response.headers.get("content-length"))
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > PORKBUN_MAX_BODY_BYTES
  ) {
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
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      length += value.byteLength
      if (length > PORKBUN_MAX_BODY_BYTES) {
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function parseRetryAt(response: Response): Date | null {
  const reset = response.headers.get("x-ratelimit-reset")
  if (!reset) {
    return null
  }
  const asSeconds = Number(reset)
  if (Number.isFinite(asSeconds)) {
    const date = new Date(asSeconds * 1000)
    return Number.isNaN(date.getTime()) ? null : date
  }
  const date = new Date(reset)
  return Number.isNaN(date.getTime()) ? null : date
}

function classifyError(error: unknown): "network" | "timeout" {
  return error instanceof DOMException && error.name === "TimeoutError"
    ? "timeout"
    : "network"
}

/**
 * Reads all domains visible to the Porkbun credentials. The request is GET-only
 * and sends credentials exclusively in headers. It never calls SSL, DNS, or
 * any mutating Porkbun endpoint. Missing either credential disables enrichment
 * without a network request.
 */
export async function fetchPorkbunAccountDomains(
  options: PorkbunDomainClientOptions = {}
): Promise<PorkbunDomainLookup> {
  const apiKey = readCredential((options.env ?? process.env).PORKBUN_API_KEY)
  const secretKey = readCredential(
    (options.env ?? process.env).PORKBUN_SECRET_KEY
  )
  if (!(apiKey && secretKey)) {
    return { outcome: "unconfigured", domains: [] }
  }

  const fetcher = options.fetcher ?? fetch
  const domains = new Map<string, PorkbunDomainRenewalFacts>()
  let start = 0
  for (let page = 0; page < PORKBUN_MAX_PAGES; page += 1) {
    const url = new URL(PORKBUN_LIST_ALL_URL)
    url.searchParams.set("start", String(start))
    let response: Response
    try {
      response = await fetcher(url.toString(), {
        method: "GET",
        headers: {
          accept: "application/json",
          "X-API-Key": apiKey,
          "X-Secret-API-Key": secretKey,
        },
        signal: AbortSignal.timeout(PORKBUN_TIMEOUT_MS),
      })
    } catch (error) {
      return { outcome: "failed", domains: [], reason: classifyError(error) }
    }
    if (response.status === 429) {
      return {
        outcome: "rate-limited",
        domains: [],
        retryAt: parseRetryAt(response),
      }
    }
    if (!response.ok) {
      return { outcome: "failed", domains: [], reason: "http" }
    }
    let body: string | null
    try {
      body = await readCappedBody(response)
    } catch (error) {
      return { outcome: "failed", domains: [], reason: classifyError(error) }
    }
    if (body === null) {
      return { outcome: "failed", domains: [], reason: "oversized-response" }
    }
    let document: PorkbunListResponse
    try {
      document = JSON.parse(body) as PorkbunListResponse
    } catch {
      return { outcome: "failed", domains: [], reason: "malformed-response" }
    }
    if (document.status !== "SUCCESS" || !Array.isArray(document.domains)) {
      return { outcome: "failed", domains: [], reason: "malformed-response" }
    }
    if (document.domains.length > PORKBUN_PAGE_SIZE) {
      return { outcome: "failed", domains: [], reason: "malformed-response" }
    }
    for (const record of document.domains) {
      const facts = parseDomainRecord(record)
      if (facts) {
        domains.set(facts.domain, facts)
      }
    }
    if (document.domains.length < PORKBUN_PAGE_SIZE) {
      return { outcome: "resolved", domains: [...domains.values()] }
    }
    start += document.domains.length
  }
  return { outcome: "failed", domains: [], reason: "pagination-limit" }
}
