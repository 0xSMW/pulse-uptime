// incident.io's Statuspage-compatible adapter. Covers OpenAI, Clerk, and
// Resend. Component and incident status strings match statuspage_v2, but
// incident objects never carry affected-component associations and some
// standard Statuspage routes (unresolved, scheduled maintenance) 404. This
// adapter never requests those routes, and infers a component association
// only when it can do so safely: exactly one active incident.

import { z } from "zod"

import type { DependencySourceManifest } from "../manifest"
import type { NormalizedProviderSnapshot } from "../types"
import { scopeFromComponentIds } from "../types"

import type {
  AdapterDocument,
  AdapterRequestDescriptor,
  CatalogDirectoryInput,
  DependencyAdapter,
  NormalizeInput,
} from "./index"
import {
  AdapterParseError,
  catalogDirectoryFromNormalize,
  documentsOfKind,
  latestTimestamp,
  requireIsoTimestamp,
  requireJson,
  requireProviderIncidentState,
  toBoundedPlainText,
} from "./shared"
import { mapComponentStatus } from "./statuspage-v2"

const componentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string(),
  updated_at: z.string().nullable().optional(),
})

const incidentUpdateSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  body: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
})

// Deliberately no `components` field: incident.io compat incidents never carry one.
const incidentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string(),
  impact: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  monitoring_at: z.string().nullable().optional(),
  resolved_at: z.string().nullable().optional(),
  incident_updates: z.array(incidentUpdateSchema).optional().default([]),
})

const summaryDocSchema = z
  .object({
    page: z.object({ id: z.string().min(1), updated_at: z.string() }),
    status: z.object({ indicator: z.string(), description: z.string() }),
    components: z.array(componentSchema),
    incidents: z.array(incidentSchema).optional().default([]),
  })
  .strict()

const incidentsDocSchema = z
  .object({
    page: z.object({ id: z.string().min(1), updated_at: z.string() }),
    incidents: z.array(incidentSchema),
  })
  .strict()

type Incident = z.infer<typeof incidentSchema>

function parseJson<T>(
  schema: z.ZodType<T>,
  json: unknown,
  sourceId: string,
  what: string
): T {
  const result = schema.safeParse(json)
  if (!result.success) {
    throw new AdapterParseError(
      "SCHEMA_INVALID",
      `${sourceId}: ${what} failed schema validation: ${result.error.message}`
    )
  }
  return result.data
}

function findDocument(
  documents: AdapterDocument[],
  kind: "current" | "incidents"
): AdapterDocument | undefined {
  return documentsOfKind(documents, kind)[0]
}

function mapIncident(
  incident: Incident,
  componentIds: string[],
  sourceId: string
): NormalizedProviderSnapshot["incidents"][number] {
  return {
    externalId: incident.id,
    title: incident.name,
    state: requireProviderIncidentState(incident.status, sourceId),
    impact: incident.impact ?? null,
    startedAt: requireIsoTimestamp(
      incident.created_at,
      sourceId,
      "incident.created_at"
    ),
    resolvedAt: incident.resolved_at
      ? requireIsoTimestamp(
          incident.resolved_at,
          sourceId,
          "incident.resolved_at"
        )
      : null,
    updatedAt: requireIsoTimestamp(
      incident.updated_at,
      sourceId,
      "incident.updated_at"
    ),
    canonicalUrl: null,
    // Inference succeeds with ids (components scope). No result is unmapped,
    // never source-wide: empty inference is not a page-level claim.
    scope: scopeFromComponentIds(componentIds),
    updates: incident.incident_updates.map((update) => ({
      externalId: update.id,
      state: requireProviderIncidentState(update.status, sourceId),
      bodyText: toBoundedPlainText(update.body),
      createdAt: requireIsoTimestamp(
        update.created_at,
        sourceId,
        "incident_update.created_at"
      ),
      updatedAt: requireIsoTimestamp(
        update.updated_at,
        sourceId,
        "incident_update.updated_at"
      ),
    })),
  }
}

export const incidentioCompatAdapter: DependencyAdapter = {
  requests(source: DependencySourceManifest): AdapterRequestDescriptor[] {
    const requests: AdapterRequestDescriptor[] = [
      { kind: "current", url: source.currentUrl, optional: false },
    ]
    if (source.incidentsUrl) {
      requests.push({
        kind: "incidents",
        url: source.incidentsUrl,
        optional: false,
      })
    }
    // No maintenance descriptor: the Statuspage-only maintenance routes 404 for incident.io compat sources.
    return requests
  },

  catalogDirectory(input: CatalogDirectoryInput) {
    return catalogDirectoryFromNormalize(incidentioCompatAdapter, input)
  },

  normalize(input: NormalizeInput): NormalizedProviderSnapshot {
    const { source, documents, observedAt } = input
    const currentDocument = findDocument(documents, "current")
    const summary = parseJson(
      summaryDocSchema,
      requireJson(currentDocument, source.id, "summary"),
      source.id,
      "summary.json"
    )

    const components: NormalizedProviderSnapshot["components"] = {}
    for (const component of summary.components) {
      components[component.id] = {
        state: mapComponentStatus(component.status, source.id),
        updatedAt: component.updated_at ?? null,
      }
    }

    const incidentsDocument = findDocument(documents, "incidents")
    const allIncidents = incidentsDocument
      ? parseJson(
          incidentsDocSchema,
          requireJson(incidentsDocument, source.id, "incidents"),
          source.id,
          "incidents.json"
        ).incidents
      : summary.incidents

    const activeIncidents = allIncidents.filter(
      (incident) => incident.status !== "resolved"
    )
    const nonOperationalComponentIds = summary.components
      .filter((component) => component.status !== "operational")
      .map((component) => component.id)

    // Associate the single active incident with whatever is non-operational
    // right now. Two or more active incidents stay provider-level: guessing
    // which title belongs to which component would be a fabricated signal.
    const inferredComponentIds =
      activeIncidents.length === 1 ? nonOperationalComponentIds : []

    const incidents = allIncidents.map((incident) =>
      mapIncident(
        incident,
        incident.status !== "resolved" && activeIncidents.length === 1
          ? inferredComponentIds
          : [],
        source.id
      )
    )

    const providerUpdatedAt = latestTimestamp([
      summary.page.updated_at,
      ...incidents.map((incident) => incident.updatedAt),
    ])

    return {
      sourceId: source.id,
      observedAt,
      providerUpdatedAt,
      componentsComplete: true,
      // The required incidents.json (and summary.incidents) list every
      // incident, resolved ones keeping their resolved_at rather than
      // vanishing, so the open-incident set is complete.
      incidentsComplete: true,
      components,
      incidents,
      maintenances: [],
      cache: { etag: null, lastModified: null },
    }
  },
}
