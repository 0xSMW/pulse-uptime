// Google Cloud status adapter. One document, incidents.json, serves both
// current state and incident history: there is no separate always-on
// component listing, so a product with no active incident here simply has
// no entry in `components`. Callers treat an absent product id as
// OPERATIONAL. products.json (component identity and names) is a
// catalog-validation concern, not a polling concern, so this adapter never
// reads it.

import { z } from "zod";

import type { DependencySourceManifest } from "../manifest";
import type { NormalizedProviderSnapshot } from "../types";

import type { AdapterRequestDescriptor, DependencyAdapter, NormalizeInput } from "./index";
import { AdapterParseError, latestTimestamp, requireIsoTimestamp, requireJson, toBoundedPlainText } from "./shared";

const productRefSchema = z.object({ id: z.string().min(1) });
const locationRefSchema = z.object({ id: z.string().min(1) });

const updateSchema = z.object({
  created: z.string(),
  modified: z.string(),
  text: z.string().nullable().optional(),
  status: z.string().optional(),
});

const incidentSchema = z.object({
  id: z.string().min(1),
  begin: z.string(),
  end: z.string().nullable().optional(),
  modified: z.string(),
  external_desc: z.string().nullable().optional(),
  severity: z.string().nullable().optional(),
  status_impact: z.string(),
  uri: z.string(),
  affected_products: z.array(productRefSchema).optional().default([]),
  currently_affected_locations: z.array(locationRefSchema).optional().default([]),
  previously_affected_locations: z.array(locationRefSchema).optional().default([]),
  updates: z.array(updateSchema).optional().default([]),
});

const incidentsDocSchema = z.array(incidentSchema);

type Incident = z.infer<typeof incidentSchema>;

type ComponentState = "OPERATIONAL" | "DEGRADED" | "OUTAGE" | "MAINTENANCE";

const SEVERITY_RANK: Record<ComponentState, number> = { OPERATIONAL: 0, MAINTENANCE: 1, DEGRADED: 2, OUTAGE: 3 };

/** SERVICE_OUTAGE, SERVICE_DISRUPTION, and SERVICE_INFORMATION (while active) are Google's complete impact vocabulary. */
function mapStatusImpact(statusImpact: string, sourceId: string): ComponentState {
  switch (statusImpact) {
    case "SERVICE_OUTAGE":
      return "OUTAGE";
    case "SERVICE_DISRUPTION":
    case "SERVICE_INFORMATION":
      return "DEGRADED";
    default:
      throw new AdapterParseError("UNKNOWN_STATUS", `${sourceId}: unrecognized status_impact "${statusImpact}"`);
  }
}

/**
 * Google's own incident objects carry no investigating/identified/monitoring
 * lifecycle field, only begin/end and a per-update "status" that mirrors
 * status_impact until a final "AVAILABLE" update declares recovery. Active
 * incidents map to "identified" (we know what's affected; Google gives no
 * finer signal), resolved incidents to "resolved".
 */
function incidentState(incident: Incident): "identified" | "resolved" {
  return incident.end ? "resolved" : "identified";
}

function updateState(update: z.infer<typeof updateSchema>): "resolved" | "identified" {
  return update.status === "AVAILABLE" ? "resolved" : "identified";
}

/**
 * Bare product ids for direct component matching, plus productId@locationId
 * composites for optional location scoping. The composite set reflects the
 * incident's current affected footprint. While an incident is active only
 * currently_affected_locations count, because Google moves a location to
 * previously_affected once that region recovers while the incident stays open
 * for other regions. Folding previously_affected in for an active incident
 * would leave a recovered location's composite on the open incident, and
 * resolveDependencyState in persist.ts would report it as touched and still
 * degraded. A resolved incident includes both sets so location-scoped
 * dependencies still match it as history.
 */
function componentIdsForIncident(incident: Incident): string[] {
  const productIds = incident.affected_products.map((product) => product.id);
  const locationRefs = incident.end
    ? [...incident.currently_affected_locations, ...incident.previously_affected_locations]
    : incident.currently_affected_locations;
  const locationIds = locationRefs.map((location) => location.id);
  const composites = productIds.flatMap((productId) => locationIds.map((locationId) => `${productId}@${locationId}`));
  return [...new Set([...productIds, ...composites])];
}

function mapIncident(incident: Incident, sourceId: string): NormalizedProviderSnapshot["incidents"][number] {
  return {
    externalId: incident.id,
    title: toBoundedPlainText(incident.external_desc) || "Google Cloud incident",
    state: incidentState(incident),
    impact: incident.severity ?? null,
    startedAt: requireIsoTimestamp(incident.begin, sourceId, "incident.begin"),
    resolvedAt: incident.end ? requireIsoTimestamp(incident.end, sourceId, "incident.end") : null,
    updatedAt: requireIsoTimestamp(incident.modified, sourceId, "incident.modified"),
    canonicalUrl: new URL(incident.uri, "https://status.cloud.google.com/").toString(),
    componentIds: componentIdsForIncident(incident),
    updates: incident.updates.map((update) => ({
      // Google updates have no id of their own; the creation timestamp is the stable, immutable identity.
      externalId: update.created,
      state: updateState(update),
      bodyText: toBoundedPlainText(update.text),
      createdAt: requireIsoTimestamp(update.created, sourceId, "update.created"),
      updatedAt: requireIsoTimestamp(update.modified, sourceId, "update.modified"),
    })),
  };
}

export const googleCloudStatusAdapter: DependencyAdapter = {
  requests(source: DependencySourceManifest): AdapterRequestDescriptor[] {
    return [{ kind: "current", url: source.currentUrl, optional: false }];
  },

  normalize(input: NormalizeInput): NormalizedProviderSnapshot {
    const { source, documents, observedAt } = input;
    const document = documents[0];
    const json = requireJson(document, source.id, "incidents");
    const result = incidentsDocSchema.safeParse(json);
    if (!result.success) {
      throw new AdapterParseError("SCHEMA_INVALID", `${source.id}: incidents.json failed schema validation: ${result.error.message}`);
    }
    const rawIncidents = result.data;

    const components: NormalizedProviderSnapshot["components"] = {};
    for (const incident of rawIncidents) {
      if (incident.end) continue; // only active incidents contribute to current component state
      const state = mapStatusImpact(incident.status_impact, source.id);
      for (const product of incident.affected_products) {
        const existing = components[product.id];
        if (!existing || SEVERITY_RANK[state] > SEVERITY_RANK[existing.state]) {
          components[product.id] = { state, updatedAt: incident.modified };
        }
      }
    }

    const incidents = rawIncidents.map((incident) => mapIncident(incident, source.id));
    const providerUpdatedAt = latestTimestamp(incidents.map((incident) => incident.updatedAt));

    return {
      sourceId: source.id,
      observedAt,
      providerUpdatedAt,
      // The feed only ever lists products with an active incident, never a
      // full component roster, so an absent product id means operational,
      // not missing. See resolveDependencyState in persist.ts.
      componentsComplete: false,
      components,
      incidents,
      maintenances: [],
      cache: { etag: null, lastModified: null },
    };
  },
};
