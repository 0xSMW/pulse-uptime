// Incident-feed adapter, the first incident_only fidelity source. It reads a
// provider's officially documented RSS or Atom incident feed through the
// raw-text fetch mode and the shared bounded XML parser, then displays each
// entry as provider incident prose verbatim. It never asserts a per-component
// state: the feed carries no structured component identity, so every incident
// leaves componentIds empty and provider-wide state is operational unless an
// active, unresolved incident is present. Resolution is read from the entry's
// own structured status markers (a Statuspage feed leads each update with a
// RESOLVED, COMPLETED, or POSTMORTEM marker), never from an incident sliding
// out of the rolling window. OpenRouter is the launch source: its
// status.openrouter.ai/incidents.rss is a Statuspage-generated incident
// history and the only stable documented surface it exposes.

import type { DependencySourceManifest } from "../manifest";
import type { NormalizedProviderSnapshot } from "../types";
import { parseFeed, XmlParseError, type XmlFeedItem } from "../xml";

import type { AdapterRequestDescriptor, DependencyAdapter, NormalizeInput } from "./index";
import { AdapterParseError, documentsOfKind, latestTimestamp } from "./shared";

type ProviderIncidentState =
  | "investigating"
  | "identified"
  | "monitoring"
  | "resolved"
  | "scheduled"
  | "in_progress"
  | "completed";

type MarkerInfo = { state: ProviderIncidentState; resolved: boolean };

// The Statuspage RSS status markers, uppercase in the feed, mapped to the
// normalized lifecycle vocabulary. Terminal markers (resolved true) close the
// incident. The parser strips the surrounding markup, so a marker survives as
// a bare uppercase word immediately before the " - " update delimiter, which
// is what MARKER_PATTERN keys on. A postmortem is post-resolution, so it maps
// to resolved. Verifying is a still-running maintenance phase, so it maps to
// in_progress rather than a terminal state.
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
};

// Matches the newest update's status marker: a recognized uppercase keyword
// immediately followed by the " - " delimiter the feed puts between a marker
// and its update body. The parser strips the surrounding markup to empty rather
// than to a space, so a marker can abut the preceding timestamp (for example
// "UTCIDENTIFIED"). A leading word boundary would then fail, so the keyword is
// matched as a case-sensitive substring instead. Uppercase-only markers and the
// " - " delimiter keep this from firing on ordinary mixed-case prose. The
// parser lists updates newest first, so the leftmost match is the current
// status, and multi-word "IN PROGRESS" leads the alternation so it wins over
// any single word at the same position.
const MARKER_PATTERN = /(IN PROGRESS|INVESTIGATING|IDENTIFIED|MONITORING|POSTMORTEM|COMPLETED|SCHEDULED|VERIFYING|RESOLVED)\s*-\s/;

// An entry whose prose carries no recognized marker cannot be shown as
// resolved, so it is surfaced as an active, unresolved incident. This is the
// safe direction: it never hides an outage behind a false resolution. A real
// Statuspage history always marks its resolved entries, so this fallback only
// engages on genuine format drift.
const DEFAULT_ACTIVE_STATE: ProviderIncidentState = "investigating";

/** Reads the newest update's marker from the parsed, markup-stripped description. Absent a recognized marker the entry is treated as an active incident. */
function resolveMarker(description: string | null): MarkerInfo {
  if (description) {
    const match = MARKER_PATTERN.exec(description);
    if (match) return STATUS_MARKERS[match[1]];
  }
  return { state: DEFAULT_ACTIVE_STATE, resolved: false };
}

/** Parses an RFC822 or ISO timestamp to ISO 8601, falling back to observedAt when the feed omits or malforms it. */
function toIsoTimestamp(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

/** Milliseconds for pubDate ordering, oldest when the feed omits or malforms the date, so a dated duplicate always wins over an undated one. */
function pubDateMillis(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? Number.NEGATIVE_INFINITY : parsed.getTime();
}

/** Normalizes an entry link to an absolute https URL, since Statuspage RSS emits scheme-less links like "status.example.com/incidents/abc". Returns null when no usable URL is present. */
function canonicalUrlOf(link: string | null): string | null {
  if (!link) return null;
  const candidate = /^https?:\/\//i.test(link) ? link : `https://${link}`;
  try {
    return new URL(candidate).toString();
  } catch {
    return null;
  }
}

/** The stable identity of an entry: its guid, falling back to its link. An entry with neither cannot be deduped or stored and is dropped. */
function externalIdOf(item: XmlFeedItem): string | null {
  return item.guid ?? item.link ?? null;
}

export const incidentFeedAdapter: DependencyAdapter = {
  requests(source: DependencySourceManifest): AdapterRequestDescriptor[] {
    // A single raw-text document serves as both the current-state read and the
    // incident history: the feed is the provider's only surface. The "current"
    // kind lets the poller take the 304 fast path when the feed is unchanged.
    return [{ kind: "current", url: source.currentUrl, optional: false, mode: "text" }];
  },

  normalize(input: NormalizeInput): NormalizedProviderSnapshot {
    const { source, documents, observedAt } = input;

    const document = documentsOfKind(documents, "current")[0];
    if (!document || typeof document.text !== "string") {
      throw new AdapterParseError("MISSING_DOCUMENT", `${source.id}: missing incident feed document`);
    }
    // A payload that is not an RSS or Atom feed (a provider error page, an HTML
    // interstitial) must fail loudly rather than read as an empty, operational
    // feed. The poller then keeps the last known state.
    if (!/<rss\b/i.test(document.text) && !/<feed\b/i.test(document.text)) {
      throw new AdapterParseError("SCHEMA_INVALID", `${source.id}: document is not an RSS or Atom feed`);
    }

    let items: XmlFeedItem[];
    try {
      items = parseFeed(document.text);
    } catch (error) {
      // The shared parser rejects oversized input and any DTD or entity
      // declaration (the billion-laughs and XXE vectors). Surface that as an
      // adapter parse failure so the poller records it and holds prior state.
      if (error instanceof XmlParseError) {
        throw new AdapterParseError("SCHEMA_INVALID", `${source.id}: incident feed rejected by parser (${error.code})`);
      }
      throw error;
    }

    // Dedup by external id, keeping the entry with the newest pubDate so a feed
    // that republishes an incident under one guid collapses to its latest state.
    const byId = new Map<string, XmlFeedItem>();
    for (const item of items) {
      const externalId = externalIdOf(item);
      if (!externalId) continue;
      const existing = byId.get(externalId);
      if (!existing || pubDateMillis(item.pubDate) >= pubDateMillis(existing.pubDate)) {
        byId.set(externalId, item);
      }
    }

    const incidents: NormalizedProviderSnapshot["incidents"] = [];
    for (const [externalId, item] of byId) {
      const marker = resolveMarker(item.description);
      const startedAt = toIsoTimestamp(item.pubDate, observedAt);
      const title = item.title ?? "Provider incident";
      const bodyText = item.description ?? title;
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
        // No structured component identity exists in an incident feed. An empty
        // componentIds set makes an active incident a source-wide (page-level)
        // signal rather than a per-component claim.
        componentIds: [],
        // One update carries the entry's prose verbatim (already bounded by the
        // parser). The feed does not expose stable per-update identity, so the
        // update id is derived from the incident id.
        updates: [{
          externalId: `${externalId}#0`,
          state: marker.state,
          bodyText,
          createdAt: startedAt,
          updatedAt: startedAt,
        }],
      });
    }

    return {
      sourceId: source.id,
      observedAt,
      providerUpdatedAt: latestTimestamp(incidents.map((incident) => incident.updatedAt)),
      // The feed publishes no per-component state, so components stays empty and
      // complete. An incident_only preset's selector never matches a component,
      // so it resolves to UNKNOWN outside an active incident, as documented: the
      // feed cannot assert operational.
      componentsComplete: true,
      components: {},
      // The incident history is a rolling window that can drop a still-open
      // incident, so absence is never read as resolution. Resolution comes only
      // from an explicit terminal marker on the entry itself.
      incidentsComplete: false,
      incidents,
      // Maintenance windows arrive as ordinary incident entries carrying
      // scheduled, in_progress, or completed markers, never a separate structured
      // maintenance record.
      maintenances: [],
      cache: { etag: null, lastModified: null },
    };
  },
};
