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
 * One RDAP lookup for a registrable apex. Every failure mode degrades to
 * null facts, and the outcome field says whether the nulls mean "RDAP has
 * no data" (uncovered) or "the lookup broke" (failed), so run accounting
 * can separate known non-coverage from real probe regressions. No surface
 * renders null facts as a warning either way.
 */
export async function fetchDomainFacts(
  apex: string,
  fetcher: RdapFetcher = fetch
): Promise<DomainFacts> {
  const failed: DomainFacts = {
    expiresAt: null,
    registrar: null,
    outcome: "failed",
  }
  try {
    const response = await fetcher(
      `${RDAP_BASE_URL}${encodeURIComponent(apex)}`,
      {
        signal: AbortSignal.timeout(RDAP_TIMEOUT_MS),
        headers: { accept: "application/rdap+json" },
      }
    )
    if (!response.ok) {
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
  } catch {
    return failed
  }
}
