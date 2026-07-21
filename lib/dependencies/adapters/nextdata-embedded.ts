// nextdata_embedded adapter. Covers a status page that serves no JSON API but
// embeds its state in a Next.js __NEXT_DATA__ script tag on the server-rendered
// HTML. Hetzner (status.hetzner.com) is the launch source: pageProps carries a
// systems[] tree with stable integer ids and an incidents object grouping
// active and historical items. The adapter reads the page through the raw-text
// fetch mode, extracts only the __NEXT_DATA__ script content under a strict size
// guard, parses that slice as JSON, and derives component state purely from the
// structured system id an incident references. It never reads incident prose to
// infer a component reading, and never executes page scripts.

import { z } from "zod";

import type { DependencySourceManifest } from "../manifest";
import type { NormalizedProviderSnapshot } from "../types";
import { scopeFromComponentIds } from "../types";

import type { AdapterDocument, AdapterRequestDescriptor, CatalogDirectoryInput, DependencyAdapter, NormalizeInput } from "./index";
import { catalogDirectoryFromNormalize } from "./shared";
import {
  AdapterParseError,
  documentsOfKind,
  isProviderIncidentState,
  latestTimestamp,
  requireIsoTimestamp,
  terminalResolvedAt,
  toBoundedPlainText,
} from "./shared";

/**
 * Strict upper bound on the extracted __NEXT_DATA__ JSON slice, 768 KB. The
 * fetch layer already caps the whole HTML document (this source raises that cap
 * to 1 MB for headroom), and this second bound keeps the embedded payload the
 * adapter parses from ever growing unbounded even if the outer cap is later
 * widened. An oversized slice fails the source rather than parsing, so the
 * dependency keeps its last known state and goes stale to UNKNOWN.
 */
export const MAX_NEXT_DATA_BYTES = 768 * 1024;

// The opening tag Next.js emits for its hydration payload. The closing
// </script> that follows is the true end: Next.js escapes any literal </script>
// inside JSON string values as <\/script>, so the first match after the open
// tag never lands inside the payload.
const NEXT_DATA_OPEN = /<script id="__NEXT_DATA__"[^>]*>/;

const systemSchema = z.object({
  id: z.number().int(),
  titleEn: z.string().nullable().optional(),
  titleDe: z.string().nullable().optional(),
  systemState: z.string().nullable().optional(),
  parent: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
}).loose();

const incidentUpdateSchema = z.object({
  id: z.number().int(),
  incidentState: z.string(),
  descriptionEn: z.string().nullable().optional(),
  descriptionDe: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).loose();

const incidentItemSchema = z.object({
  id: z.number().int(),
  system: z.string().nullable().optional(),
  titleEn: z.string().nullable().optional(),
  titleDe: z.string().nullable().optional(),
  descriptionEn: z.string().nullable().optional(),
  descriptionDe: z.string().nullable().optional(),
  incidentType: z.string(),
  incidentState: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startTime: z.string().nullable().optional(),
  endTime: z.string().nullable().optional(),
  incidentUpdates: z.array(incidentUpdateSchema).optional().default([]),
}).loose();

const incidentsSchema = z.object({
  topNotification: z.array(incidentItemSchema).optional().default([]),
  informationList: z.array(incidentItemSchema).optional().default([]),
  maintenanceList: z.array(incidentItemSchema).optional().default([]),
  incidentHistory: z.array(incidentItemSchema).optional().default([]),
}).loose();

const nextDataSchema = z.object({
  props: z.object({
    pageProps: z.object({
      systems: z.array(systemSchema),
      incidents: incidentsSchema,
    }).loose(),
  }).loose(),
}).loose();

type IncidentItem = z.infer<typeof incidentItemSchema>;
type ComponentState = "OPERATIONAL" | "DEGRADED" | "OUTAGE" | "MAINTENANCE";

// worst_of severity ranking, matching the selector aggregation order in
// types.ts: OUTAGE, then DEGRADED, then MAINTENANCE, then OPERATIONAL. A
// component with several active incidents keeps the most severe.
const SEVERITY: Record<ComponentState, number> = { OPERATIONAL: 0, MAINTENANCE: 1, DEGRADED: 2, OUTAGE: 3 };

function worseOf(current: ComponentState, candidate: ComponentState): ComponentState {
  return SEVERITY[candidate] > SEVERITY[current] ? candidate : current;
}

// Provider incident states that mean the incident is over, so it never flips a
// component off OPERATIONAL. "scheduled" is future maintenance that has not
// started. Every other state (identified, in_progress, monitoring, and any
// mapped unknown) is treated as active, so an ambiguous state degrades rather
// than hides a live problem.
const CLOSED_STATES: ReadonlySet<string> = new Set(["resolved", "completed", "false_alarm", "scheduled"]);

/**
 * Maps a Hetzner incidentState onto the fixed provider vocabulary. Hetzner uses
 * identified, in_progress, scheduled, resolved, and monitoring directly, plus a
 * plain "update" note that carries no lifecycle change, folded onto monitoring.
 * A genuinely novel state throws so the source fails loud and keeps its last
 * known state rather than silently mismapping.
 */
function mapIncidentState(raw: string, sourceId: string): string {
  if (raw === "update") return "monitoring";
  if (isProviderIncidentState(raw)) return raw;
  throw new AdapterParseError("UNKNOWN_STATUS", `${sourceId}: unrecognized incident state "${raw}"`);
}

/**
 * Maps a Hetzner incidentType onto the component impact it represents while an
 * incident is active. "outage" is an OUTAGE, "maintenance" a MAINTENANCE, and
 * "other" a Hetzner advisory (capacity limits, provisioning restrictions) that
 * degrades the component. An unrecognized type degrades rather than throws, so a
 * new advisory category never silences a component or fails the whole source.
 */
function impactForType(incidentType: string): ComponentState {
  switch (incidentType) {
    case "outage":
      return "OUTAGE";
    case "maintenance":
      return "MAINTENANCE";
    default:
      return "DEGRADED";
  }
}

// A system reference is always the string "/systems/N". The component map is
// keyed by the bare integer id as a string, which is exactly what a catalog
// selector pins, so parsing the trailing id lines the two up.
function parseSystemId(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const match = /^\/systems\/(\d+)$/.exec(ref);
  return match ? match[1] : null;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Extracts the __NEXT_DATA__ script content from the raw HTML under a strict
 * size guard. A missing tag or an unclosed tag is a MISSING_DOCUMENT, and a
 * slice past the byte cap is a SCHEMA_INVALID. Either way the source fails
 * rather than parsing, so a truncated or absent payload never fabricates state.
 */
export function extractNextDataSlice(html: string, sourceId: string): string {
  const openMatch = NEXT_DATA_OPEN.exec(html);
  if (!openMatch) {
    throw new AdapterParseError("MISSING_DOCUMENT", `${sourceId}: no __NEXT_DATA__ script tag in status page`);
  }
  const start = openMatch.index + openMatch[0].length;
  const end = html.indexOf("</script>", start);
  if (end === -1) {
    throw new AdapterParseError("MISSING_DOCUMENT", `${sourceId}: __NEXT_DATA__ script tag was never closed`);
  }
  const slice = html.slice(start, end);
  // A UTF-16 code unit is at least one UTF-8 byte, so a slice whose unit count
  // already tops the cap is definitely over it and is rejected without encoding
  // the whole string. Only the borderline case pays for a byte-accurate count.
  if (slice.length > MAX_NEXT_DATA_BYTES) {
    throw new AdapterParseError("SCHEMA_INVALID", `${sourceId}: embedded __NEXT_DATA__ payload exceeds the ${MAX_NEXT_DATA_BYTES} byte cap`);
  }
  const byteLength = new TextEncoder().encode(slice).length;
  if (byteLength > MAX_NEXT_DATA_BYTES) {
    throw new AdapterParseError("SCHEMA_INVALID", `${sourceId}: embedded __NEXT_DATA__ payload of ${byteLength} bytes exceeds the ${MAX_NEXT_DATA_BYTES} byte cap`);
  }
  return slice;
}

function requireText(document: AdapterDocument | undefined, sourceId: string): string {
  if (!document || document.text === undefined) {
    throw new AdapterParseError("MISSING_DOCUMENT", `${sourceId}: missing status page document`);
  }
  return document.text;
}

export const nextdataEmbeddedAdapter: DependencyAdapter = {
  requests(source: DependencySourceManifest): AdapterRequestDescriptor[] {
    // The whole state lives in one server-rendered HTML page. It is read in
    // text mode so the fetch layer returns the decoded body without JSON.parse,
    // and this adapter does the extraction and parsing itself.
    return [{ kind: "current", url: source.currentUrl, optional: false, mode: "text" }];
  },

  catalogDirectory(input: CatalogDirectoryInput) {
    return catalogDirectoryFromNormalize(nextdataEmbeddedAdapter, input);
  },

  normalize(input: NormalizeInput): NormalizedProviderSnapshot {
    const { source, documents, observedAt } = input;
    const html = requireText(documentsOfKind(documents, "current")[0], source.id);
    const slice = extractNextDataSlice(html, source.id);

    let raw: unknown;
    try {
      raw = JSON.parse(slice);
    } catch {
      throw new AdapterParseError("SCHEMA_INVALID", `${source.id}: __NEXT_DATA__ payload is not valid JSON`);
    }

    const parsed = nextDataSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AdapterParseError("SCHEMA_INVALID", `${source.id}: __NEXT_DATA__ failed schema validation: ${parsed.error.message}`);
    }
    const pageProps = parsed.data.props.pageProps;

    // Every enumerated system starts OPERATIONAL and is only flipped by an
    // active incident that structurally references its id. This is the
    // operational-unless-referenced rule: the feed carries no per-component
    // status field, so the sole signal is the structured system association on
    // an incident, never its prose.
    const componentStates: Record<string, ComponentState> = {};
    const componentUpdatedAt: Record<string, string | null> = {};
    for (const system of pageProps.systems) {
      const id = String(system.id);
      componentStates[id] = "OPERATIONAL";
      componentUpdatedAt[id] = system.updatedAt ?? null;
    }

    const allItems = [
      ...pageProps.incidents.topNotification,
      ...pageProps.incidents.informationList,
      ...pageProps.incidents.maintenanceList,
      ...pageProps.incidents.incidentHistory,
    ];

    const incidents: NormalizedProviderSnapshot["incidents"] = [];
    const maintenances: NormalizedProviderSnapshot["maintenances"] = [];
    const seenIncidentIds = new Set<string>();

    for (const item of allItems) {
      const externalId = String(item.id);
      // The four lists can overlap: an active item in topNotification can also
      // sit in incidentHistory. Keep the first occurrence so an incident is
      // emitted once.
      if (seenIncidentIds.has(externalId)) continue;
      seenIncidentIds.add(externalId);

      const mappedState = mapIncidentState(item.incidentState, source.id);
      const systemId = parseSystemId(item.system);

      // Flip the referenced component only while the incident is active. A
      // resolved or scheduled item never changes a component reading.
      if (systemId && !CLOSED_STATES.has(mappedState) && systemId in componentStates) {
        componentStates[systemId] = worseOf(componentStates[systemId], impactForType(item.incidentType));
      }

      if (item.incidentType === "maintenance") {
        maintenances.push(mapMaintenance(item, mappedState, systemId, source.id));
      } else {
        incidents.push(mapIncident(item, mappedState, systemId, source));
      }
    }

    const components: NormalizedProviderSnapshot["components"] = {};
    for (const [id, state] of Object.entries(componentStates)) {
      components[id] = { state, updatedAt: componentUpdatedAt[id] ?? null };
    }

    const providerUpdatedAt = latestTimestamp([
      ...pageProps.systems.map((system) => system.updatedAt ?? null),
      ...allItems.map((item) => item.updatedAt),
    ]);

    return {
      sourceId: source.id,
      observedAt,
      providerUpdatedAt,
      // The systems tree enumerates every component the page publishes, so a
      // selector id absent from components is genuinely gone and resolves to
      // UNKNOWN rather than being assumed operational.
      componentsComplete: true,
      // topNotification, informationList, and maintenanceList are the page's
      // authoritative current-state lists, so every open incident is present on
      // a successful fetch and an open incident that drops out has genuinely
      // resolved. incidentHistory only adds already-resolved records, which
      // carry resolvedAt and never reopen the completeness question.
      incidentsComplete: true,
      components,
      incidents,
      maintenances,
      cache: { etag: null, lastModified: null },
    };
  },
};

function mapIncident(
  item: IncidentItem,
  mappedState: string,
  systemId: string | null,
  source: { id: string; statusPageUrl: string },
): NormalizedProviderSnapshot["incidents"][number] {
  const sourceId = source.id;
  const title = firstNonEmpty(item.titleEn, item.titleDe) ?? `Hetzner ${item.incidentType} notice`;
  // Compute started/updated once so terminal resolution ordering reuses the
  // same anchors the rest of the row stores.
  const startedAt = requireIsoTimestamp(item.startTime ?? item.createdAt, sourceId, "incident.startTime");
  const updatedAt = requireIsoTimestamp(item.updatedAt, sourceId, "incident.updatedAt");
  const explicitEnd = item.endTime ? requireIsoTimestamp(item.endTime, sourceId, "incident.endTime") : null;
  // Terminal states close via endTime, falling back to updatedAt, always at or
  // after startedAt. Active states stay unresolved even when endTime is set.
  const resolvedAt = terminalResolvedAt({
    state: mappedState,
    startedAt,
    explicitResolvedAt: explicitEnd,
    providerUpdatedAt: updatedAt,
  });
  return {
    externalId: String(item.id),
    title,
    state: mappedState,
    impact: null,
    startedAt,
    resolvedAt,
    updatedAt,
    // Hetzner has no working per-incident permalink (the /incidents/{id} route
    // 404s), so the canonical link is the status page itself, which lists the
    // active incident inline and stays on an allowed host.
    canonicalUrl: source.statusPageUrl,
    // systemId absent means the incident has no component relation to match.
    scope: scopeFromComponentIds(systemId ? [systemId] : []),
    updates: item.incidentUpdates.map((update) => ({
      externalId: String(update.id),
      state: mapIncidentState(update.incidentState, sourceId),
      bodyText: toBoundedPlainText(update.descriptionEn ?? update.descriptionDe),
      createdAt: requireIsoTimestamp(update.createdAt, sourceId, "incident_update.createdAt"),
      updatedAt: requireIsoTimestamp(update.updatedAt, sourceId, "incident_update.updatedAt"),
    })),
  };
}

function mapMaintenance(
  item: IncidentItem,
  mappedState: string,
  systemId: string | null,
  sourceId: string,
): NormalizedProviderSnapshot["maintenances"][number] {
  return {
    externalId: String(item.id),
    state: mappedState,
    startsAt: requireIsoTimestamp(item.startTime ?? item.createdAt, sourceId, "maintenance.startTime"),
    endsAt: item.endTime ? requireIsoTimestamp(item.endTime, sourceId, "maintenance.endTime") : null,
    componentIds: systemId ? [systemId] : [],
  };
}
