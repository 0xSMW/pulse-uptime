// Incident-feed adapter, the first incident_only fidelity source. It reads a
// provider's officially documented RSS or Atom incident feed through the
// raw-text fetch mode and the shared bounded XML parser, then displays each
// entry as provider incident prose verbatim. It never asserts a per-component
// state: the feed carries no structured component identity, so every incident
// carries source-wide scope and provider-wide state is operational unless an
// active, unresolved incident is present. Resolution markers are read from the
// entry's own structured status prefixes (a Statuspage feed leads each update
// with a RESOLVED, COMPLETED, or POSTMORTEM marker). Whether absence from the
// feed closes open incidents is driven by config.incidentInventory:
// active_only (Azure) enumerates every open incident, rolling_history
// (OpenRouter) is a window that must never treat silence as resolution.

import type { DependencySourceManifest } from "../manifest"
import type { NormalizedProviderSnapshot } from "../types"
import { sourceIncidentScope } from "../types"
import { parseFeed, type XmlFeedItem, XmlParseError } from "../xml"

import type {
  AdapterRequestDescriptor,
  CatalogDirectoryInput,
  DependencyAdapter,
  NormalizeInput,
} from "./index"
import { AdapterParseError, documentsOfKind, latestTimestamp } from "./shared"

type ProviderIncidentState =
  | "investigating"
  | "identified"
  | "monitoring"
  | "resolved"
  | "scheduled"
  | "in_progress"
  | "completed"

export type IncidentFeedInventory = "active_only" | "rolling_history"

interface MarkerInfo {
  state: ProviderIncidentState
  resolved: boolean
}

// The Statuspage RSS status markers, uppercase in the feed, mapped to the
// normalized lifecycle vocabulary. Terminal markers (resolved true) close the
// incident. A postmortem is post-resolution, so it maps to resolved. Verifying
// is a still-running maintenance phase, so it maps to in_progress rather than
// a terminal state.
const STATUS_MARKERS: Record<string, MarkerInfo> = {
  RESOLVED: { state: "resolved", resolved: true },
  POSTMORTEM: { state: "resolved", resolved: true },
  COMPLETED: { state: "completed", resolved: true },
  MONITORING: { state: "monitoring", resolved: false },
  IDENTIFIED: { state: "identified", resolved: false },
  INVESTIGATING: { state: "investigating", resolved: false },
  SCHEDULED: { state: "scheduled", resolved: false },
  VERIFYING: { state: "in_progress", resolved: false },
  "IN PROGRESS": { state: "in_progress", resolved: false },
}

// Exact vocabulary tokens, longest first so "IN PROGRESS" wins over a partial.
const MARKER_TOKEN =
  "(IN PROGRESS|INVESTIGATING|IDENTIFIED|MONITORING|POSTMORTEM|COMPLETED|SCHEDULED|VERIFYING|RESOLVED)"
// Marker at the very start of the description or a normalized update segment.
const MARKER_AT_START = new RegExp(`^${MARKER_TOKEN}\\s*-\\s`)
// Marker immediately after a recognized timestamp timezone token (UTC/GMT).
// Statuspage prefixes each update with "Mon DD, HH:MM UTC" then the marker.
const MARKER_AFTER_TZ = new RegExp(
  `\\b(?:UTC|GMT)\\s+${MARKER_TOKEN}\\s*-\\s`,
  "g"
)

// An entry whose prose carries no recognized marker cannot be shown as
// resolved, so it is surfaced as an active, unresolved incident. This is the
// safe direction: it never hides an outage behind a false resolution.
const DEFAULT_ACTIVE_STATE: ProviderIncidentState = "investigating"
const DEFAULT_ACTIVE_MARKER: MarkerInfo = {
  state: DEFAULT_ACTIVE_STATE,
  resolved: false,
}

/**
 * Reads the current lifecycle marker from markup-stripped incident prose.
 * A valid marker is an exact vocabulary token plus the " - " delimiter, only
 * at the start of the description, the start of a normalized update segment,
 * or immediately after a UTC/GMT timezone token. Mid-body prose never counts.
 * The first valid marker in provider order (document order, newest first on
 * Statuspage) determines state. No valid marker yields the active fallback.
 */
export function parseIncidentFeedUpdateMarker(
  description: string | null
): MarkerInfo {
  if (!description) {
    return DEFAULT_ACTIVE_MARKER
  }

  let bestIndex = Number.POSITIVE_INFINITY
  let bestToken: string | null = null

  const consider = (token: string, index: number) => {
    if (index < bestIndex) {
      bestIndex = index
      bestToken = token
    }
  }

  const atStart = MARKER_AT_START.exec(description)
  // biome-ignore lint/suspicious/noUnnecessaryConditions: exec returns null when the pattern does not match, biome infers it as non-null
  if (atStart) {
    consider(atStart[1]!, 0)
  }

  MARKER_AFTER_TZ.lastIndex = 0
  let match = MARKER_AFTER_TZ.exec(description)
  // biome-ignore lint/suspicious/noUnnecessaryConditions: exec returns null when the pattern does not match, biome infers it as non-null
  while (match) {
    // match[0] starts at UTC/GMT; the token itself is the position we rank.
    const tokenOffset = match[0].indexOf(match[1]!)
    consider(match[1]!, match.index + tokenOffset)
    match = MARKER_AFTER_TZ.exec(description)
  }

  if (!bestToken) {
    return DEFAULT_ACTIVE_MARKER
  }
  return STATUS_MARKERS[bestToken] ?? DEFAULT_ACTIVE_MARKER
}

/**
 * Strict reader for config.incidentInventory. Manifest validation already
 * requires this for incident_feed, but the adapter re-checks so a drifted
 * runtime config never invents completeness.
 */
export function requireIncidentInventory(
  source: DependencySourceManifest
): IncidentFeedInventory {
  const value = source.config.incidentInventory
  if (value === "active_only" || value === "rolling_history") {
    return value
  }
  throw new AdapterParseError(
    "SCHEMA_INVALID",
    `${source.id}: config.incidentInventory must be "active_only" or "rolling_history"`
  )
}

/** Parses an RFC822 or ISO timestamp to ISO 8601, falling back to observedAt when the feed omits or malforms it. */
function toIsoTimestamp(value: string | null, fallback: string): string {
  if (!value) {
    return fallback
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString()
}

/** Milliseconds for pubDate ordering, oldest when the feed omits or malforms the date, so a dated duplicate always wins over an undated one. */
function pubDateMillis(value: string | null): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? Number.NEGATIVE_INFINITY
    : parsed.getTime()
}

/** Normalizes an entry link to an absolute https URL, since Statuspage RSS emits scheme-less links like "status.example.com/incidents/abc". Returns null when no usable URL is present. */
function canonicalUrlOf(link: string | null): string | null {
  if (!link) {
    return null
  }
  const candidate = /^https?:\/\//i.test(link) ? link : `https://${link}`
  try {
    return new URL(candidate).toString()
  } catch {
    return null
  }
}

/** The stable identity of an entry: its guid, falling back to its link. An entry with neither cannot be deduped or stored and is dropped. */
function externalIdOf(item: XmlFeedItem): string | null {
  return item.guid ?? item.link ?? null
}

export const incidentFeedAdapter: DependencyAdapter = {
  requests(source: DependencySourceManifest): AdapterRequestDescriptor[] {
    // A single raw-text document serves as both the current-state read and the
    // incident history: the feed is the provider's only surface. The "current"
    // kind lets the poller take the 304 fast path when the feed is unchanged.
    return [
      {
        kind: "current",
        url: source.currentUrl,
        optional: false,
        mode: "text",
      },
    ]
  },

  catalogDirectory(input: CatalogDirectoryInput) {
    // The feed publishes no per-component inventory. Presets select synthetic
    // component ids, so the directory declares tracksComponents false and
    // catalog reconcile never treats those ids as upstream drift.
    void input
    return {
      componentIds: new Set<string>(),
      childrenByParent: new Map(),
      locationsByProduct: new Map(),
      complete: true,
      tracksComponents: false,
    }
  },

  normalize(input: NormalizeInput): NormalizedProviderSnapshot {
    const { source, documents, observedAt } = input
    const inventory = requireIncidentInventory(source)

    const document = documentsOfKind(documents, "current")[0]
    if (!document || typeof document.text !== "string") {
      throw new AdapterParseError(
        "MISSING_DOCUMENT",
        `${source.id}: missing incident feed document`
      )
    }
    // A payload that is not an RSS or Atom feed (a provider error page, an HTML
    // interstitial) must fail loudly rather than read as an empty, operational
    // feed. The poller then keeps the last known state.
    if (!(/<rss\b/i.test(document.text) || /<feed\b/i.test(document.text))) {
      throw new AdapterParseError(
        "SCHEMA_INVALID",
        `${source.id}: document is not an RSS or Atom feed`
      )
    }

    let items: XmlFeedItem[]
    try {
      items = parseFeed(document.text)
    } catch (error) {
      // The shared parser rejects oversized input and any DTD or entity
      // declaration (the billion-laughs and XXE vectors). Surface that as an
      // adapter parse failure so the poller records it and holds prior state.
      // Network failures, optional misses, malformed envelopes, and budget
      // exhaustion never reach here as an authoritative empty set.
      if (error instanceof XmlParseError) {
        // biome-ignore lint/style/useErrorCause: cause is threaded through the error options arg, biome only detects the native second-argument position
        throw new AdapterParseError(
          "SCHEMA_INVALID",
          `${source.id}: incident feed rejected by parser (${error.code})`,
          { cause: error }
        )
      }
      throw error
    }

    // Dedup by external id, keeping the entry with the newest pubDate so a feed
    // that republishes an incident under one guid collapses to its latest state.
    const byId = new Map<string, XmlFeedItem>()
    for (const item of items) {
      const externalId = externalIdOf(item)
      if (!externalId) {
        continue
      }
      const existing = byId.get(externalId)
      if (
        !existing ||
        pubDateMillis(item.pubDate) >= pubDateMillis(existing.pubDate)
      ) {
        byId.set(externalId, item)
      }
    }

    const incidents: NormalizedProviderSnapshot["incidents"] = []
    for (const [externalId, item] of byId) {
      const marker = parseIncidentFeedUpdateMarker(item.description)
      const startedAt = toIsoTimestamp(item.pubDate, observedAt)
      const title = item.title ?? "Provider incident"
      const bodyText = item.description ?? title
      incidents.push({
        externalId,
        title,
        state: marker.state,
        impact: null,
        startedAt,
        // The feed carries no distinct resolution timestamp in structured form,
        // so a resolved entry records its pubDate. Presence, not precision, is
        // what marks the incident closed for the poller.
        resolvedAt: marker.resolved ? startedAt : null,
        updatedAt: startedAt,
        canonicalUrl: canonicalUrlOf(item.link),
        // No structured component identity: the feed is source-wide by design.
        scope: sourceIncidentScope(),
        // One update carries the entry's prose verbatim (already bounded by the
        // parser). The feed does not expose stable per-update identity, so the
        // update id is derived from the incident id.
        updates: [
          {
            externalId: `${externalId}#0`,
            state: marker.state,
            bodyText,
            createdAt: startedAt,
            updatedAt: startedAt,
          },
        ],
      })
    }

    return {
      sourceId: source.id,
      observedAt,
      providerUpdatedAt: latestTimestamp(
        incidents.map((incident) => incident.updatedAt)
      ),
      // The feed publishes no per-component state, so components stays empty and
      // complete. An incident_only preset's selector never matches a component,
      // so it resolves to UNKNOWN outside an active incident, as documented: the
      // feed cannot assert operational.
      componentsComplete: true,
      components: {},
      // active_only: a successful snapshot lists every open incident, so absence
      // closes. rolling_history: the window can drop a still-open incident, so
      // absence is never resolution and only an explicit terminal marker closes.
      incidentsComplete: inventory === "active_only",
      incidents,
      // Maintenance windows arrive as ordinary incident entries carrying
      // scheduled, in_progress, or completed markers, never a separate structured
      // maintenance record.
      maintenances: [],
      cache: { etag: null, lastModified: null },
    }
  },
}
