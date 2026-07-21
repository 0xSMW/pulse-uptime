// Helpers shared by every status-feed adapter. Adapters are pure: they never
// fetch, they only turn already-fetched documents into a
// NormalizedProviderSnapshot. Keeping the shared bits here keeps each
// adapter file focused on its provider's own document shapes.

import { providerIncidentStates } from "@/lib/db/schema"

import type { DependencySourceManifest } from "../manifest"
import type {
  CatalogComponentDirectory,
  NormalizedProviderSnapshot,
} from "../types"
import { catalogDirectoryFromComponentIds } from "../types"

import type {
  AdapterDocument,
  AdapterDocumentKind,
  NormalizeInput,
} from "./index"

/**
 * Default directory builder for adapters whose normalize() output is a complete
 * component map with no group or location structure. Statuspage overrides this
 * with richer group parsing. Kept in shared so adapters can import it without
 * a circular dependency through the registry index.
 */
export function catalogDirectoryFromNormalize(
  adapter: { normalize: (input: NormalizeInput) => NormalizedProviderSnapshot },
  input: { source: DependencySourceManifest; documents: AdapterDocument[] }
): CatalogComponentDirectory {
  const snapshot = adapter.normalize({
    source: input.source,
    documents: input.documents,
    observedAt: new Date(0).toISOString(),
  })
  return catalogDirectoryFromComponentIds(Object.keys(snapshot.components))
}

const MAX_BODY_BYTES = 4096

/** A document an adapter could not normalize. The poller keeps the dependency's last known state on any of these. */
export type AdapterParseErrorCode =
  | "SCHEMA_INVALID"
  | "UNKNOWN_STATUS"
  | "MISSING_DOCUMENT"

export class AdapterParseError extends Error {
  constructor(
    readonly code: AdapterParseErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "AdapterParseError"
  }
}

const PROVIDER_INCIDENT_STATE_SET: ReadonlySet<string> = new Set(
  providerIncidentStates
)

/** True only for the 9-value vocabulary the provider_incidents check constraint accepts. */
export function isProviderIncidentState(
  value: string
): value is (typeof providerIncidentStates)[number] {
  return PROVIDER_INCIDENT_STATE_SET.has(value)
}

/** Validates a provider status string against the fixed incident/update vocabulary, or throws. */
export function requireProviderIncidentState(
  value: string,
  sourceId: string
): (typeof providerIncidentStates)[number] {
  if (!isProviderIncidentState(value)) {
    throw new AdapterParseError(
      "UNKNOWN_STATUS",
      `${sourceId}: unrecognized incident state "${value}"`
    )
  }
  return value
}

/** Terminal lifecycle values: the incident is over and must not color an active component. */
export function isTerminalIncidentState(state: string): boolean {
  return (
    state === "resolved" || state === "completed" || state === "false_alarm"
  )
}

/**
 * resolvedAt for a normalized incident. Active (non-terminal) always null.
 * Terminal uses the explicit resolution timestamp when present, otherwise the
 * provider update timestamp, ordered at or after startedAt so a provider that
 * publishes resolution before start never trips the resolution-order check.
 */
export function terminalResolvedAt(input: {
  state: string
  startedAt: string
  explicitResolvedAt?: string | null
  providerUpdatedAt: string
}): string | null {
  if (!isTerminalIncidentState(input.state)) {
    return null
  }
  const candidate = input.explicitResolvedAt ?? input.providerUpdatedAt
  return new Date(candidate) < new Date(input.startedAt)
    ? input.startedAt
    : candidate
}

/** Strips tags, decodes the handful of entities providers actually use, collapses whitespace, and caps to 4 KB. */
export function toBoundedPlainText(input: string | null | undefined): string {
  if (!input) {
    return ""
  }
  const withoutTags = input.replace(/<[^>]*>/g, " ")
  const decoded = withoutTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
  const collapsed = decoded.replace(/\s+/g, " ").trim()
  return capUtf8Bytes(collapsed, MAX_BODY_BYTES)
}

function capUtf8Bytes(text: string, maxBytes: number): string {
  // A UTF-16 code unit encodes to at most 3 UTF-8 bytes, so any string this
  // short is already under the cap and needs no encoding at all. This keeps the
  // common case allocation free and bounds the cost on untrusted provider text.
  if (text.length * 3 <= maxBytes) {
    return text
  }
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= maxBytes) {
    return text
  }
  // Cut at the byte cap, then walk back over any UTF-8 continuation bytes
  // (0x80 to 0xBF) so we land on a code point boundary and never split a
  // multibyte sequence or a surrogate pair. Decoding the prefix is then valid.
  let end = maxBytes
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1
  }
  return new TextDecoder().decode(bytes.subarray(0, end))
}

/** Rejects timestamps that don't parse, so a malformed feed fails loudly instead of storing garbage. */
export function requireIsoTimestamp(
  value: string,
  sourceId: string,
  field: string
): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new AdapterParseError(
      "SCHEMA_INVALID",
      `${sourceId}: invalid timestamp for ${field}: "${value}"`
    )
  }
  return value
}

/** Latest of a list of ISO timestamps (nullable entries ignored), or null when none are present. */
export function latestTimestamp(
  values: Array<string | null | undefined>
): string | null {
  const present = values.filter((value): value is string => Boolean(value))
  if (present.length === 0) {
    return null
  }
  return present.reduce((latest, current) =>
    new Date(current) > new Date(latest) ? current : latest
  )
}

/** All fetched documents of one role (there can be several: paginated components, one notice detail per notice). */
export function documentsOfKind(
  documents: AdapterDocument[],
  kind: AdapterDocumentKind
): AdapterDocument[] {
  return documents.filter((document) => document.kind === kind)
}

/** The JSON body of a document, or throws MISSING_DOCUMENT when the poller didn't fetch it. */
export function requireJson(
  document: AdapterDocument | undefined,
  sourceId: string,
  what: string
): unknown {
  if (!document || document.json === undefined) {
    throw new AdapterParseError(
      "MISSING_DOCUMENT",
      `${sourceId}: missing ${what} document`
    )
  }
  return document.json
}
