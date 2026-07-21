// Statuspage v2 adapter. Covers Anthropic, Vercel, Cloudflare, WorkOS,
// Supabase, Upstash, Stripe, Twilio, and GitHub per the catalog. Reads
// summary.json for component state and currently active incidents, falls
// back to incidents.json for full incident/update history, and only needs
// scheduled-maintenances/active.json when summary omits active maintenance.

import { z } from "zod"

import type { DependencySourceManifest } from "../manifest"
import type {
  CatalogComponentDirectory,
  CatalogDirectoryOption,
  NormalizedProviderSnapshot,
} from "../types"
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
  documentsOfKind,
  latestTimestamp,
  requireIsoTimestamp,
  requireJson,
  requireProviderIncidentState,
  toBoundedPlainText,
} from "./shared"

const componentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string(),
  updated_at: z.string().nullable().optional(),
  // Group membership retained for catalog directory discovery. Poll normalize
  // ignores these fields. group is true on the parent rollup component.
  group: z.boolean().optional(),
  group_id: z.string().min(1).nullable().optional(),
  components: z.array(z.string().min(1)).optional(),
})

const incidentUpdateSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  body: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
})

const incidentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string(),
  impact: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable().optional(),
  resolved_at: z.string().nullable().optional(),
  components: z.array(componentSchema).optional().default([]),
  incident_updates: z.array(incidentUpdateSchema).optional().default([]),
})

const maintenanceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string(),
  scheduled_for: z.string(),
  scheduled_until: z.string().nullable().optional(),
  components: z.array(componentSchema).optional().default([]),
})

const summaryDocSchema = z
  .object({
    page: z.object({ id: z.string().min(1), updated_at: z.string() }),
    status: z.object({ indicator: z.string(), description: z.string() }),
    components: z.array(componentSchema),
    incidents: z.array(incidentSchema).optional().default([]),
    scheduled_maintenances: z.array(maintenanceSchema).optional().default([]),
  })
  .strict()

const incidentsDocSchema = z
  .object({
    page: z.object({ id: z.string().min(1), updated_at: z.string() }),
    incidents: z.array(incidentSchema),
  })
  .strict()

const maintenanceDocSchema = z
  .object({
    page: z.object({ id: z.string().min(1), updated_at: z.string() }),
    scheduled_maintenances: z.array(maintenanceSchema),
  })
  .strict()

type Incident = z.infer<typeof incidentSchema>
type Maintenance = z.infer<typeof maintenanceSchema>

/** operational, degraded_performance, partial_outage, major_outage, under_maintenance is the complete Statuspage vocabulary. */
export function mapComponentStatus(
  status: string,
  sourceId: string
): "OPERATIONAL" | "DEGRADED" | "OUTAGE" | "MAINTENANCE" {
  switch (status) {
    case "operational":
      return "OPERATIONAL"
    case "degraded_performance":
    case "partial_outage":
      return "DEGRADED"
    case "major_outage":
      return "OUTAGE"
    case "under_maintenance":
      return "MAINTENANCE"
    default:
      throw new AdapterParseError(
        "UNKNOWN_STATUS",
        `${sourceId}: unrecognized component status "${status}"`
      )
  }
}

/**
 * Statuspage lifecycle statuses the fixed 9-value incident vocabulary has no
 * slot for, folded onto their nearest equivalent.
 *
 * - "verifying" sits between maintenance's in_progress and completed. It maps
 *   to "monitoring": both mean a fix is applied and the provider is watching
 *   to confirm it held.
 * - "postmortem" is the standard terminal status a provider sets once an
 *   incident is over and a retrospective has been published. It maps to
 *   "resolved": the incident is closed, and every postmortem incident already
 *   carries resolved_at so resolvedAt is preserved.
 */
function normalizeIncidentOrMaintenanceStatus(status: string): string {
  if (status === "verifying") {
    return "monitoring"
  }
  if (status === "postmortem") {
    return "resolved"
  }
  return status
}

/**
 * The public incident permalink under the source's own status page host,
 * status.example.com/incidents/{id}. Statuspage also returns a shortlink on
 * the shared stspg.io shortener, but that host is in no source's
 * allowedHosts, so safeProviderUrl rewrites it back to the generic status
 * page and the deep link is lost (see persist.ts). The permalink keeps the
 * per-incident deep link while staying on the host safeProviderUrl already
 * allows. encodeURIComponent plus the URL base guarantee an untrusted id
 * cannot escape the incidents path or the host.
 */
function incidentPermalink(statusPageUrl: string, incidentId: string): string {
  return new URL(
    `incidents/${encodeURIComponent(incidentId)}`,
    statusPageUrl
  ).toString()
}

function mapIncident(
  incident: Incident,
  source: { id: string; statusPageUrl: string }
): NormalizedProviderSnapshot["incidents"][number] {
  const sourceId = source.id
  return {
    externalId: incident.id,
    title: incident.name,
    state: requireProviderIncidentState(
      normalizeIncidentOrMaintenanceStatus(incident.status),
      sourceId
    ),
    impact: incident.impact ?? null,
    startedAt: requireIsoTimestamp(
      incident.started_at ?? incident.created_at,
      sourceId,
      "incident.started_at"
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
    canonicalUrl: incidentPermalink(source.statusPageUrl, incident.id),
    scope: scopeFromComponentIds(
      incident.components.map((component) => component.id)
    ),
    updates: incident.incident_updates.map((update) => ({
      externalId: update.id,
      state: requireProviderIncidentState(
        normalizeIncidentOrMaintenanceStatus(update.status),
        sourceId
      ),
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

function mapMaintenance(
  maintenance: Maintenance,
  sourceId: string
): NormalizedProviderSnapshot["maintenances"][number] {
  return {
    externalId: maintenance.id,
    state: requireProviderIncidentState(
      normalizeIncidentOrMaintenanceStatus(maintenance.status),
      sourceId
    ),
    startsAt: requireIsoTimestamp(
      maintenance.scheduled_for,
      sourceId,
      "maintenance.scheduled_for"
    ),
    endsAt: maintenance.scheduled_until
      ? requireIsoTimestamp(
          maintenance.scheduled_until,
          sourceId,
          "maintenance.scheduled_until"
        )
      : null,
    componentIds: maintenance.components.map((component) => component.id),
  }
}

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
  kind: "current" | "incidents" | "maintenance"
): AdapterDocument | undefined {
  return documentsOfKind(documents, kind)[0]
}

/**
 * Builds childrenByParent from Statuspage summary components. Children are
 * components that declare group_id, keyed by that parent. A group's own
 * `components` membership list is retained only as metadata when present.
 */
function statuspageCatalogDirectory(
  summaryComponents: ReadonlyArray<{
    id: string
    name: string
    group?: boolean
    group_id?: string | null
    components?: string[]
  }>
): CatalogComponentDirectory {
  const componentIds = new Set<string>()
  const childrenByParent = new Map<string, CatalogDirectoryOption[]>()
  const membershipByParent = new Map<string, string[]>()

  for (const component of summaryComponents) {
    componentIds.add(component.id)
    if (component.group && component.components) {
      membershipByParent.set(component.id, [...component.components])
    }
    if (component.group_id) {
      const list = childrenByParent.get(component.group_id) ?? []
      list.push({
        id: component.id,
        label: component.name,
        metadata: { groupId: component.group_id },
      })
      childrenByParent.set(component.group_id, list)
    }
  }

  // Prefer group_id edges. When a parent lists members but no child carried
  // group_id (unusual Statuspage shape), fall back to membership ids with
  // labels resolved from the component map.
  const labelById = new Map(
    summaryComponents.map((component) => [component.id, component.name])
  )
  for (const [parentId, memberIds] of membershipByParent) {
    if (childrenByParent.has(parentId)) {
      continue
    }
    childrenByParent.set(
      parentId,
      memberIds.map((id) => ({
        id,
        label: labelById.get(id) ?? id,
        metadata: { groupId: parentId, fromMembership: true },
      }))
    )
  }

  return {
    componentIds,
    childrenByParent,
    locationsByProduct: new Map(),
    complete: true,
    tracksComponents: true,
  }
}

export const statuspageV2Adapter: DependencyAdapter = {
  requests(source: DependencySourceManifest): AdapterRequestDescriptor[] {
    const requests: AdapterRequestDescriptor[] = [
      { kind: "current", url: source.currentUrl, optional: false },
    ]
    if (source.incidentsUrl) {
      // Fetched by the poller only when an active incident changed or disappeared;
      // summary.json already carries the currently active incidents inline.
      requests.push({
        kind: "incidents",
        url: source.incidentsUrl,
        optional: true,
      })
    }
    requests.push({
      kind: "maintenance",
      url: new URL(
        "/api/v2/scheduled-maintenances/active.json",
        source.currentUrl
      ).toString(),
      optional: true,
    })
    return requests
  },

  catalogDirectory(input: CatalogDirectoryInput): CatalogComponentDirectory {
    const currentDocument = findDocument(input.documents, "current")
    const summary = parseJson(
      summaryDocSchema,
      requireJson(currentDocument, input.source.id, "summary"),
      input.source.id,
      "summary.json"
    )
    return statuspageCatalogDirectory(summary.components)
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
    const incidentsSource = incidentsDocument
      ? parseJson(
          incidentsDocSchema,
          requireJson(incidentsDocument, source.id, "incidents"),
          source.id,
          "incidents.json"
        ).incidents
      : summary.incidents
    const incidents = incidentsSource.map((incident) =>
      mapIncident(incident, source)
    )

    const maintenanceDocument = findDocument(documents, "maintenance")
    const maintenancesSource = maintenanceDocument
      ? parseJson(
          maintenanceDocSchema,
          requireJson(maintenanceDocument, source.id, "maintenance"),
          source.id,
          "scheduled-maintenances/active.json"
        ).scheduled_maintenances
      : summary.scheduled_maintenances
    const maintenances = maintenancesSource.map((maintenance) =>
      mapMaintenance(maintenance, source.id)
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
      // summary.json authoritatively enumerates every currently-unresolved
      // incident inline, and normalize() requires that summary document, so the
      // authoritative open set is present on every snapshot. incidents.json only
      // adds resolved history, never a still-open incident summary.json omitted,
      // so the open set stays complete even on a cycle where the optional
      // incidents.json failed and this fell back to summary.incidents. An open
      // incident absent from the set has genuinely resolved.
      incidentsComplete: true,
      components,
      incidents,
      maintenances,
      cache: { etag: null, lastModified: null },
    }
  },
}
