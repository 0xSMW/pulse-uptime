// Statuspage v2 adapter. Covers Anthropic, Vercel, Cloudflare, WorkOS,
// Supabase, Upstash, Stripe, Twilio, and GitHub per the catalog. Reads
// summary.json for component state and currently active incidents, falls
// back to incidents.json for full incident/update history, and only needs
// scheduled-maintenances/active.json when summary omits active maintenance.

import { z } from "zod";

import type { DependencySourceManifest } from "../manifest";
import type { NormalizedProviderSnapshot } from "../types";

import type { AdapterDocument, AdapterRequestDescriptor, DependencyAdapter, NormalizeInput } from "./index";
import { AdapterParseError, documentsOfKind, latestTimestamp, requireIsoTimestamp, requireJson, requireProviderIncidentState, toBoundedPlainText } from "./shared";

const componentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string(),
  updated_at: z.string().nullable().optional(),
});

const incidentUpdateSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  body: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

const incidentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string(),
  impact: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable().optional(),
  resolved_at: z.string().nullable().optional(),
  shortlink: z.string().nullable().optional(),
  components: z.array(componentSchema).optional().default([]),
  incident_updates: z.array(incidentUpdateSchema).optional().default([]),
});

const maintenanceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string(),
  scheduled_for: z.string(),
  scheduled_until: z.string().nullable().optional(),
  components: z.array(componentSchema).optional().default([]),
});

const summaryDocSchema = z.object({
  page: z.object({ id: z.string().min(1), updated_at: z.string() }),
  status: z.object({ indicator: z.string(), description: z.string() }),
  components: z.array(componentSchema),
  incidents: z.array(incidentSchema).optional().default([]),
  scheduled_maintenances: z.array(maintenanceSchema).optional().default([]),
}).strict();

const incidentsDocSchema = z.object({
  page: z.object({ id: z.string().min(1), updated_at: z.string() }),
  incidents: z.array(incidentSchema),
}).strict();

const maintenanceDocSchema = z.object({
  page: z.object({ id: z.string().min(1), updated_at: z.string() }),
  scheduled_maintenances: z.array(maintenanceSchema),
}).strict();

type Incident = z.infer<typeof incidentSchema>;
type Maintenance = z.infer<typeof maintenanceSchema>;

/** operational, degraded_performance, partial_outage, major_outage, under_maintenance is the complete Statuspage vocabulary. */
export function mapComponentStatus(status: string, sourceId: string): "OPERATIONAL" | "DEGRADED" | "OUTAGE" | "MAINTENANCE" {
  switch (status) {
    case "operational":
      return "OPERATIONAL";
    case "degraded_performance":
    case "partial_outage":
      return "DEGRADED";
    case "major_outage":
      return "OUTAGE";
    case "under_maintenance":
      return "MAINTENANCE";
    default:
      throw new AdapterParseError("UNKNOWN_STATUS", `${sourceId}: unrecognized component status "${status}"`);
  }
}

/**
 * Statuspage maintenance lifecycle includes "verifying" between in_progress
 * and completed, which the fixed 9-value incident vocabulary has no slot
 * for. It maps to "monitoring": both mean the same thing, a fix is applied
 * and the provider is watching to confirm it held.
 */
function normalizeIncidentOrMaintenanceStatus(status: string): string {
  return status === "verifying" ? "monitoring" : status;
}

function mapIncident(incident: Incident, sourceId: string): NormalizedProviderSnapshot["incidents"][number] {
  return {
    externalId: incident.id,
    title: incident.name,
    state: requireProviderIncidentState(normalizeIncidentOrMaintenanceStatus(incident.status), sourceId),
    impact: incident.impact ?? null,
    startedAt: requireIsoTimestamp(incident.started_at ?? incident.created_at, sourceId, "incident.started_at"),
    resolvedAt: incident.resolved_at ? requireIsoTimestamp(incident.resolved_at, sourceId, "incident.resolved_at") : null,
    updatedAt: requireIsoTimestamp(incident.updated_at, sourceId, "incident.updated_at"),
    canonicalUrl: incident.shortlink ?? null,
    componentIds: incident.components.map((component) => component.id),
    updates: incident.incident_updates.map((update) => ({
      externalId: update.id,
      state: requireProviderIncidentState(normalizeIncidentOrMaintenanceStatus(update.status), sourceId),
      bodyText: toBoundedPlainText(update.body),
      createdAt: requireIsoTimestamp(update.created_at, sourceId, "incident_update.created_at"),
      updatedAt: requireIsoTimestamp(update.updated_at, sourceId, "incident_update.updated_at"),
    })),
  };
}

function mapMaintenance(maintenance: Maintenance, sourceId: string): NormalizedProviderSnapshot["maintenances"][number] {
  return {
    externalId: maintenance.id,
    state: requireProviderIncidentState(normalizeIncidentOrMaintenanceStatus(maintenance.status), sourceId),
    startsAt: requireIsoTimestamp(maintenance.scheduled_for, sourceId, "maintenance.scheduled_for"),
    endsAt: maintenance.scheduled_until ? requireIsoTimestamp(maintenance.scheduled_until, sourceId, "maintenance.scheduled_until") : null,
    componentIds: maintenance.components.map((component) => component.id),
  };
}

function parseJson<T>(schema: z.ZodType<T>, json: unknown, sourceId: string, what: string): T {
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new AdapterParseError("SCHEMA_INVALID", `${sourceId}: ${what} failed schema validation: ${result.error.message}`);
  }
  return result.data;
}

function findDocument(documents: AdapterDocument[], kind: "current" | "incidents" | "maintenance"): AdapterDocument | undefined {
  return documentsOfKind(documents, kind)[0];
}

export const statuspageV2Adapter: DependencyAdapter = {
  requests(source: DependencySourceManifest): AdapterRequestDescriptor[] {
    const requests: AdapterRequestDescriptor[] = [{ kind: "current", url: source.currentUrl, optional: false }];
    if (source.incidentsUrl) {
      // Fetched by the poller only when an active incident changed or disappeared;
      // summary.json already carries the currently active incidents inline.
      requests.push({ kind: "incidents", url: source.incidentsUrl, optional: true });
    }
    requests.push({
      kind: "maintenance",
      url: new URL("/api/v2/scheduled-maintenances/active.json", source.currentUrl).toString(),
      optional: true,
    });
    return requests;
  },

  normalize(input: NormalizeInput): NormalizedProviderSnapshot {
    const { source, documents, observedAt } = input;
    const currentDocument = findDocument(documents, "current");
    const summary = parseJson(summaryDocSchema, requireJson(currentDocument, source.id, "summary"), source.id, "summary.json");

    const components: NormalizedProviderSnapshot["components"] = {};
    for (const component of summary.components) {
      components[component.id] = {
        state: mapComponentStatus(component.status, source.id),
        updatedAt: component.updated_at ?? null,
      };
    }

    const incidentsDocument = findDocument(documents, "incidents");
    const incidentsSource = incidentsDocument
      ? parseJson(incidentsDocSchema, requireJson(incidentsDocument, source.id, "incidents"), source.id, "incidents.json").incidents
      : summary.incidents;
    const incidents = incidentsSource.map((incident) => mapIncident(incident, source.id));

    const maintenanceDocument = findDocument(documents, "maintenance");
    const maintenancesSource = maintenanceDocument
      ? parseJson(maintenanceDocSchema, requireJson(maintenanceDocument, source.id, "maintenance"), source.id, "scheduled-maintenances/active.json").scheduled_maintenances
      : summary.scheduled_maintenances;
    const maintenances = maintenancesSource.map((maintenance) => mapMaintenance(maintenance, source.id));

    const providerUpdatedAt = latestTimestamp([summary.page.updated_at, ...incidents.map((incident) => incident.updatedAt)]);

    return {
      sourceId: source.id,
      observedAt,
      providerUpdatedAt,
      components,
      incidents,
      maintenances,
      cache: { etag: null, lastModified: null },
    };
  },
};
