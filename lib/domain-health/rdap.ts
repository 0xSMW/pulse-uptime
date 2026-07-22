// RDAP (RFC 9083) is the structured WHOIS successor. rdap.org bootstraps the
// query to the registry's own server via redirect, so one GET per apex returns
// registry JSON with standardized event names and no per-registry parsing.
// Coverage is every gTLD plus some ccTLDs; a TLD without RDAP is a null
// result, never an error surfaced to a monitor.

import { sanitizeDisplayFact } from "./sanitize"

const RDAP_BASE_URL = "https://rdap.org/domain/"
const RDAP_TIMEOUT_MS = 10_000
const RDAP_MAX_BODY_BYTES = 1024 * 1024

export interface DomainFacts {
  expiresAt: Date | null
  registrar: string | null
}

export type RdapFetcher = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> }
) => Promise<{
  ok: boolean
  status: number
  body?: ReadableStream<Uint8Array> | null
  text: () => Promise<string>
}>

/**
 * Reads at most RDAP_MAX_BODY_BYTES from the response, byte-counted while
 * streaming so an oversized body is abandoned mid-flight, not buffered and
 * then discarded. rdap.org redirects hand the connection to arbitrary
 * registry servers, so the cap must hold before allocation. A response
 * without a body stream (test doubles) falls back to text() with a
 * post-hoc length check.
 */
async function readCappedBody(
  response: Awaited<ReturnType<RdapFetcher>>
): Promise<string | null> {
  if (!response.body) {
    const text = await response.text()
    return Buffer.byteLength(text, "utf8") > RDAP_MAX_BODY_BYTES ? null : text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
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
 * One RDAP lookup for a registrable apex. Every failure mode, missing TLD
 * coverage (404), transport errors, timeouts, unparseable JSON, degrades to
 * null facts. Callers treat null as "unknown", which no surface renders as a
 * warning.
 */
export async function fetchDomainFacts(
  apex: string,
  fetcher: RdapFetcher = fetch
): Promise<DomainFacts> {
  const empty: DomainFacts = { expiresAt: null, registrar: null }
  try {
    const response = await fetcher(
      `${RDAP_BASE_URL}${encodeURIComponent(apex)}`,
      {
        signal: AbortSignal.timeout(RDAP_TIMEOUT_MS),
        headers: { accept: "application/rdap+json" },
      }
    )
    if (!response.ok) {
      return empty
    }
    const body = await readCappedBody(response)
    if (body === null) {
      return empty
    }
    const document: unknown = JSON.parse(body)
    if (!document || typeof document !== "object") {
      return empty
    }
    const record = document as { events?: unknown; entities?: unknown }
    return {
      expiresAt: parseExpiration(record.events),
      registrar: parseRegistrar(record.entities),
    }
  } catch {
    return empty
  }
}
