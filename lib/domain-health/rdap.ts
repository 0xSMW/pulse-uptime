// RDAP (RFC 9083) is the structured WHOIS successor. rdap.org bootstraps the
// query to the registry's own server via redirect, so one GET per apex returns
// registry JSON with standardized event names and no per-registry parsing.
// Coverage is every gTLD plus some ccTLDs; a TLD without RDAP is a null
// result, never an error surfaced to a monitor.

import { Agent, request as undiciRequest } from "undici"
import {
  createSecureConnect,
  type DispatcherFactory,
} from "@/lib/checker/checker"
import {
  assertPublicAddress,
  isIpLiteral,
  normalizeIpLiteral,
} from "@/lib/checker/ip-policy"
import {
  createSecureLookup,
  type ResolveAll,
  systemResolveAll,
} from "@/lib/checker/secure-lookup"
import type { ManagedDispatcher } from "@/lib/checker/types"
import { sanitizeDisplayFact } from "./sanitize"

const RDAP_BASE_URL = "https://rdap.org/domain/"
const RDAP_TIMEOUT_MS = 10_000
const RDAP_MAX_BODY_BYTES = 1024 * 1024
const RDAP_MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export interface DomainFacts {
  expiresAt: Date | null
  registrar: string | null
  /**
   * Why the facts may be null. "resolved" answered with a parseable record,
   * "uncovered" means RDAP has no data for this domain or TLD (404), and
   * "failed" is a transport error, timeout, oversized body, unparseable
   * JSON, or a non-404 error status. Only "failed" may count as a probe
   * failure, no surface renders "uncovered" as a problem.
   */
  outcome: "resolved" | "uncovered" | "failed"
}

export type RdapFetcher = (
  url: string,
  init: {
    signal: AbortSignal
    headers: Record<string, string>
    redirect: "manual"
  }
) => Promise<{
  ok: boolean
  status: number
  headers?: Headers | Record<string, string | string[] | undefined>
  body?: ReadableStream<Uint8Array> | null
  text: () => Promise<string>
}>

interface RdapResponseBody {
  destroy?: (error?: Error) => void
  on?: (event: "error", listener: (error: Error) => void) => unknown
  getReader?: () => ReadableStreamDefaultReader<Uint8Array>
  [Symbol.asyncIterator]?: () => AsyncIterator<Buffer | Uint8Array | string>
}

interface RdapResponse {
  ok: boolean
  status: number
  headers?: Headers | Record<string, string | string[] | undefined>
  body?: RdapResponseBody | null
  text: () => Promise<string>
}

type RdapRequest = (
  url: URL,
  options: {
    dispatcher: ManagedDispatcher
    signal: AbortSignal
    headersTimeout: number
    bodyTimeout: number
    maxRedirections: 0
    headers: Record<string, string>
  }
) => Promise<RdapResponse>

export interface RdapTransportDependencies {
  resolveAll?: ResolveAll
  request?: RdapRequest
  createDispatcher?: DispatcherFactory
  now?: () => number
}

const defaultRequest: RdapRequest = async (url, options) => {
  const response = await undiciRequest(url, { method: "GET", ...options })
  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    headers: response.headers,
    body: response.body,
    text: () => response.body.text(),
  }
}

const defaultDispatcherFactory: DispatcherFactory = ({
  lookup,
  connectTimeoutMs,
  onConnectedAddress,
}) =>
  new Agent({
    connect: createSecureConnect({
      lookup,
      connectTimeoutMs,
      onConnectedAddress,
    }),
    connections: 1,
    pipelining: 0,
  })

/**
 * Reads at most RDAP_MAX_BODY_BYTES from the response, byte-counted while
 * streaming so an oversized body is abandoned mid-flight, not buffered and
 * then discarded. rdap.org redirects hand the connection to arbitrary
 * registry servers, so the cap must hold before allocation. A response
 * without a body stream (test doubles) falls back to text() with a
 * post-hoc length check.
 */
async function readCappedBody(response: RdapResponse): Promise<string | null> {
  if (!response.body) {
    const text = await response.text()
    return Buffer.byteLength(text, "utf8") > RDAP_MAX_BODY_BYTES ? null : text
  }
  const reader = response.body.getReader?.()
  const chunks: Uint8Array[] = []
  let total = 0
  if (!reader) {
    const iterate = response.body[Symbol.asyncIterator]
    if (!iterate) {
      return null
    }
    try {
      const iterable = {
        [Symbol.asyncIterator]: () => iterate.call(response.body),
      }
      for await (const chunk of iterable) {
        const bytes =
          typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk)
        total += bytes.byteLength
        if (total > RDAP_MAX_BODY_BYTES) {
          return null
        }
        chunks.push(bytes)
      }
    } finally {
      discardBody(response.body)
    }
    return Buffer.concat(chunks).toString("utf8")
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      total += value.byteLength
      if (total > RDAP_MAX_BODY_BYTES) {
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function discardBody(body: RdapResponseBody | null | undefined): void {
  body?.on?.("error", ignoreDiscardError)
  body?.destroy?.()
}

function ignoreDiscardError(): void {
  // Destroying an unread response body is expected
}

function headerValue(
  headers: RdapResponse["headers"],
  name: string
): string | undefined {
  if (!headers) {
    return
  }
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined
  }
  const value = headers[name] ?? headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function parseRdapUrl(input: string): URL {
  const url = new URL(input)
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error("Unsafe RDAP URL")
  }
  if (isIpLiteral(url.hostname)) {
    assertPublicAddress(normalizeIpLiteral(url.hostname))
  }
  return url
}

interface RdapEvent {
  eventAction?: unknown
  eventDate?: unknown
}

interface RdapEntity {
  roles?: unknown
  vcardArray?: unknown
}

function parseExpiration(events: unknown): Date | null {
  if (!Array.isArray(events)) {
    return null
  }
  for (const event of events as RdapEvent[]) {
    if (
      event &&
      typeof event === "object" &&
      event.eventAction === "expiration" &&
      typeof event.eventDate === "string"
    ) {
      const date = new Date(event.eventDate)
      if (!Number.isNaN(date.getTime())) {
        return date
      }
    }
  }
  return null
}

/**
 * The registrar display name from the entity carrying the registrar role,
 * read from the vCard fn property (RFC 9083 section 5.1). Null whenever the
 * shape is not exactly that; the registrar is decoration, not a fact worth
 * failing over.
 */
function parseRegistrar(entities: unknown): string | null {
  if (!Array.isArray(entities)) {
    return null
  }
  for (const entity of entities as RdapEntity[]) {
    if (
      !entity ||
      typeof entity !== "object" ||
      !Array.isArray(entity.roles) ||
      !entity.roles.includes("registrar") ||
      !Array.isArray(entity.vcardArray)
    ) {
      continue
    }
    const properties = entity.vcardArray[1]
    if (!Array.isArray(properties)) {
      continue
    }
    for (const property of properties) {
      if (
        Array.isArray(property) &&
        property[0] === "fn" &&
        typeof property[3] === "string"
      ) {
        const name = sanitizeDisplayFact(property[3])
        if (name) {
          return name
        }
      }
    }
  }
  return null
}

/**
 * One RDAP lookup for a registrable apex. Every failure mode degrades to
 * null facts, and the outcome field says whether the nulls mean "RDAP has
 * no data" (uncovered) or "the lookup broke" (failed), so run accounting
 * can separate known non-coverage from real probe regressions. No surface
 * renders null facts as a warning either way.
 */
export async function fetchDomainFacts(
  apex: string,
  fetcher?: RdapFetcher,
  dependencies: RdapTransportDependencies = {}
): Promise<DomainFacts> {
  const failed: DomainFacts = {
    expiresAt: null,
    registrar: null,
    outcome: "failed",
  }
  const startedAt = (dependencies.now ?? Date.now)()
  const now = dependencies.now ?? Date.now
  const executeRequest = dependencies.request ?? defaultRequest
  const createDispatcher =
    dependencies.createDispatcher ?? defaultDispatcherFactory
  const resolveAll = dependencies.resolveAll ?? systemResolveAll
  const dispatchers = new Map<string, ManagedDispatcher>()
  try {
    let currentUrl = parseRdapUrl(`${RDAP_BASE_URL}${encodeURIComponent(apex)}`)
    let redirects = 0

    for (;;) {
      const remaining = RDAP_TIMEOUT_MS - (now() - startedAt)
      if (remaining <= 0) {
        return failed
      }

      let response: RdapResponse
      if (fetcher) {
        response = await fetcher(currentUrl.href, {
          signal: AbortSignal.timeout(remaining),
          headers: { accept: "application/rdap+json" },
          redirect: "manual",
        })
      } else {
        const origin = currentUrl.origin
        let dispatcher = dispatchers.get(origin)
        if (!dispatcher) {
          dispatcher = createDispatcher({
            origin,
            lookup: createSecureLookup({ resolveAll }),
            connectTimeoutMs: remaining,
            onConnectedAddress: () => undefined,
          })
          dispatchers.set(origin, dispatcher)
        }
        response = await executeRequest(currentUrl, {
          dispatcher,
          signal: AbortSignal.timeout(remaining),
          headersTimeout: remaining,
          bodyTimeout: remaining,
          maxRedirections: 0,
          headers: { accept: "application/rdap+json" },
        })
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        discardBody(response.body)
        const location = headerValue(response.headers, "location")
        if (!location) {
          return failed
        }
        const destination = parseRdapUrl(new URL(location, currentUrl).href)
        if (redirects >= RDAP_MAX_REDIRECTS) {
          return failed
        }
        redirects += 1
        currentUrl = destination
        continue
      }

      if (!response.ok) {
        discardBody(response.body)
        // 404 is RDAP's answer for "no data here", a TLD without RDAP or an
        // unregistered domain. Anything else is the lookup itself misbehaving.
        return response.status === 404
          ? { expiresAt: null, registrar: null, outcome: "uncovered" }
          : failed
      }
      const body = await readCappedBody(response)
      if (body === null) {
        return failed
      }
      const document: unknown = JSON.parse(body)
      if (!document || typeof document !== "object") {
        return failed
      }
      const record = document as { events?: unknown; entities?: unknown }
      return {
        expiresAt: parseExpiration(record.events),
        registrar: parseRegistrar(record.entities),
        outcome: "resolved",
      }
    }
  } catch {
    return failed
  } finally {
    await Promise.allSettled(
      [...dispatchers.values()].map((dispatcher) => dispatcher.close())
    )
  }
}
