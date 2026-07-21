// Auth0 status adapter. Auth0's status page is a Next.js app whose only
// machine-readable current-state transport is the __NEXT_DATA__ payload
// embedded in the homepage HTML. /api/uptime carries per-region uptime
// percentages but no incident status, and /api/incidents and /api/status
// reject every query format, so the embedded payload is the sole source of
// structured per-region incident state.
//
// The homepage is fetched in text mode. This adapter extracts the
// __NEXT_DATA__ script tag, reads props.pageProps.activeIncidents, and
// normalizes the 10 stable regions (US-1, US-3, US-4, US-5, EU-1, EU-2, AU,
// JP-1, UK-1, CA-1) into per-region components with the region as the
// component id. State comes from each region's structured incident status and
// impact, never from prose. authenticationAffected is surfaced on every
// emitted incident's update body. Reading the live payload avoids pinning a
// Next.js buildId, so a provider redeploy never strands this source.

import { z } from "zod"

import type { DependencySourceManifest } from "../manifest"
import type {
  NormalizedProviderSnapshot,
  ProviderComponentState,
  ProviderIncidentState,
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
  catalogDirectoryFromNormalize,
  documentsOfKind,
  isTerminalIncidentState,
  latestTimestamp,
  requireIsoTimestamp,
  requireProviderIncidentState,
  terminalResolvedAt,
} from "./shared"

const incidentSchema = z
  .object({
    status: z.string(),
    name: z.string(),
    id: z.string(),
    updated_at: z.string(),
    resolved_at: z.string().nullable().optional(),
    scheduled_for: z.string().nullable().optional(),
    monitoring_at: z.string().nullable().optional(),
    authenticationAffected: z.boolean().optional().default(false),
    impact: z.string(),
    isPrivate: z.boolean().optional().default(false),
  })
  .passthrough()

const regionSchema = z
  .object({
    region: z.string().min(1),
    environment: z.string(),
    response: z.object({
      uptime: z.string().optional(),
      incidents: z.array(incidentSchema),
    }),
  })
  .passthrough()

const nextDataSchema = z
  .object({
    props: z
      .object({
        pageProps: z
          .object({
            activeIncidents: z.array(regionSchema),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough()

type Auth0Incident = z.infer<typeof incidentSchema>

// worst_of ordering per the selector contract: OUTAGE beats DEGRADED beats
// MAINTENANCE beats OPERATIONAL.
const STATE_SEVERITY: Record<ProviderComponentState, number> = {
  OPERATIONAL: 0,
  MAINTENANCE: 1,
  DEGRADED: 2,
  OUTAGE: 3,
}

// Auth0's placeholder "all clear" entry per region: an operational status with
// an empty id. It is not a real incident and never becomes a component outage
// or an emitted incident.
function isAllClear(incident: Auth0Incident): boolean {
  return incident.status === "operational" || incident.id === ""
}

// A scheduled or in-progress maintenance window rather than an unplanned
// incident. scheduled_for being set is the primary signal, with the
// maintenance lifecycle statuses and a maintenance impact as backstops.
function isMaintenance(incident: Auth0Incident): boolean {
  return (
    incident.impact === "maintenance" ||
    incident.scheduled_for != null ||
    incident.status === "scheduled" ||
    incident.status === "in_progress" ||
    incident.status === "verifying" ||
    incident.status === "completed"
  )
}

// Component state from a single non-placeholder incident. Impact drives
// severity for unplanned incidents. An active incident with an unrecognized or
// "none" impact still reads as DEGRADED rather than operational, so an
// in-progress incident is never shown green.
function incidentComponentState(
  incident: Auth0Incident
): ProviderComponentState {
  if (isMaintenance(incident)) {
    return "MAINTENANCE"
  }
  if (incident.impact === "critical" || incident.impact === "major") {
    return "OUTAGE"
  }
  return "DEGRADED"
}

// Auth0 statuses folded onto the fixed 9-value provider incident vocabulary.
// "verifying" pairs with "monitoring" (a fix is applied and being watched) and
// "postmortem" with "resolved" (the incident is closed with a retrospective).
// Anything unrecognized throws so a drifted status never mislabels an incident.
function mapIncidentStatus(
  status: string,
  sourceId: string
): ProviderIncidentState {
  const folded =
    status === "verifying"
      ? "monitoring"
      : status === "postmortem"
        ? "resolved"
        : status
  return requireProviderIncidentState(folded, sourceId)
}

// One incident accumulated across every region it affects. Auth0 repeats the
// same incident id under each affected region, so incidents are keyed by id and
// their regions collected into componentIds.
interface AggregatedIncident {
  incident: Auth0Incident
  regions: string[]
  authenticationAffected: boolean
  latestUpdatedAt: string
}

function extractNextData(text: string, sourceId: string): unknown {
  const match =
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(
      text
    )
  if (!match) {
    throw new AdapterParseError(
      "SCHEMA_INVALID",
      `${sourceId}: homepage has no __NEXT_DATA__ payload`
    )
  }
  try {
    return JSON.parse(match[1]!)
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: cause is threaded through the error options arg, biome only detects the native second-argument position
    throw new AdapterParseError(
      "SCHEMA_INVALID",
      `${sourceId}: __NEXT_DATA__ payload is not valid JSON`,
      { cause: error }
    )
  }
}

function requireCurrentText(
  documents: AdapterDocument[],
  sourceId: string
): string {
  const current = documentsOfKind(documents, "current")[0]
  if (!current || typeof current.text !== "string") {
    throw new AdapterParseError(
      "MISSING_DOCUMENT",
      `${sourceId}: missing homepage document`
    )
  }
  return current.text
}

// The earliest structured timestamp the active payload carries for an incident.
// The embedded shape has no created_at or started_at, so this prefers a
// maintenance window's scheduled_for, then the monitoring_at phase timestamp,
// and finally falls back to updated_at.
function incidentStartedAt(incident: Auth0Incident): string {
  return incident.scheduled_for ?? incident.monitoring_at ?? incident.updated_at
}

export const auth0StatusAdapter: DependencyAdapter = {
  requests(source: DependencySourceManifest): AdapterRequestDescriptor[] {
    // The homepage HTML is the only transport carrying per-region incident
    // state. It is fetched in text mode so the __NEXT_DATA__ payload can be
    // extracted without a JSON.parse of the whole HTML document.
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
    return catalogDirectoryFromNormalize(auth0StatusAdapter, input)
  },

  normalize(input: NormalizeInput): NormalizedProviderSnapshot {
    const { source, documents, observedAt } = input
    const sourceId = source.id

    const parsed = nextDataSchema.safeParse(
      extractNextData(requireCurrentText(documents, sourceId), sourceId)
    )
    if (!parsed.success) {
      throw new AdapterParseError(
        "SCHEMA_INVALID",
        `${sourceId}: activeIncidents failed schema validation: ${parsed.error.message}`
      )
    }
    const regions = parsed.data.props.pageProps.activeIncidents

    const components: NormalizedProviderSnapshot["components"] = {}
    const incidentsById = new Map<string, AggregatedIncident>()
    const maintenancesById = new Map<string, AggregatedIncident>()
    const allUpdatedAts: string[] = []

    for (const region of regions) {
      let state: ProviderComponentState = "OPERATIONAL"
      let regionUpdatedAt: string | null = null

      for (const incident of region.response.incidents) {
        allUpdatedAts.push(incident.updated_at)
        if (isAllClear(incident)) {
          // The all-clear entry still carries a real last-checked timestamp,
          // so it dates the region even when nothing is wrong.
          regionUpdatedAt = latestTimestamp([
            regionUpdatedAt,
            incident.updated_at,
          ])
          continue
        }
        // Private, tenant-scoped incidents are never surfaced on the public
        // page and carry no linkable detail, so they neither emit an incident
        // nor color the public component state.
        if (incident.isPrivate) {
          continue
        }

        // Map provider state before region severity so a terminal entry
        // (resolved, completed, false_alarm, postmortem→resolved) never
        // colors an active component. Postmortem folds to resolved first.
        const mappedState = mapIncidentStatus(incident.status, sourceId)
        regionUpdatedAt = latestTimestamp([
          regionUpdatedAt,
          incident.updated_at,
        ])
        if (!isTerminalIncidentState(mappedState)) {
          const contribution = incidentComponentState(incident)
          if (STATE_SEVERITY[contribution] > STATE_SEVERITY[state]) {
            state = contribution
          }
        }

        const bucket = isMaintenance(incident)
          ? maintenancesById
          : incidentsById
        const existing = bucket.get(incident.id)
        if (existing) {
          existing.regions.push(region.region)
          existing.authenticationAffected =
            existing.authenticationAffected || incident.authenticationAffected
          if (
            new Date(incident.updated_at) > new Date(existing.latestUpdatedAt)
          ) {
            existing.incident = incident
            existing.latestUpdatedAt = incident.updated_at
          }
        } else {
          bucket.set(incident.id, {
            incident,
            regions: [region.region],
            authenticationAffected: incident.authenticationAffected,
            latestUpdatedAt: incident.updated_at,
          })
        }
      }

      components[region.region] = { state, updatedAt: regionUpdatedAt }
    }

    const incidents: NormalizedProviderSnapshot["incidents"] = [
      ...incidentsById.values(),
    ].map((entry) => {
      const { incident } = entry
      const state = mapIncidentStatus(incident.status, sourceId)
      const updatedAt = requireIsoTimestamp(
        incident.updated_at,
        sourceId,
        "incident.updated_at"
      )
      const startedAt = requireIsoTimestamp(
        incidentStartedAt(incident),
        sourceId,
        "incident.startedAt"
      )
      const explicitResolvedAt = incident.resolved_at
        ? requireIsoTimestamp(
            incident.resolved_at,
            sourceId,
            "incident.resolved_at"
          )
        : null
      return {
        externalId: incident.id,
        title: incident.name,
        state,
        impact: incident.impact,
        startedAt,
        resolvedAt: terminalResolvedAt({
          state,
          startedAt,
          explicitResolvedAt,
          providerUpdatedAt: updatedAt,
        }),
        updatedAt,
        canonicalUrl: null,
        scope: scopeFromComponentIds(entry.regions),
        // The active payload carries no update history, so a single synthetic
        // update surfaces the structured authenticationAffected and impact
        // fields that the flat incident record has no dedicated slot for.
        // createdAt is the stable incident start; updatedAt tracks the latest
        // provider timestamp so mutable upserts advance correctly.
        updates: [
          {
            externalId: `${incident.id}:active`,
            state,
            bodyText: `Authentication affected: ${entry.authenticationAffected ? "yes" : "no"}. Impact: ${incident.impact}.`,
            createdAt: startedAt,
            updatedAt,
          },
        ],
      }
    })

    const maintenances: NormalizedProviderSnapshot["maintenances"] = [
      ...maintenancesById.values(),
    ].map((entry) => {
      const { incident } = entry
      return {
        externalId: incident.id,
        state: mapIncidentStatus(incident.status, sourceId),
        startsAt: requireIsoTimestamp(
          incidentStartedAt(incident),
          sourceId,
          "maintenance.startsAt"
        ),
        endsAt: incident.resolved_at
          ? requireIsoTimestamp(
              incident.resolved_at,
              sourceId,
              "maintenance.resolved_at"
            )
          : null,
        componentIds: entry.regions,
      }
    })

    return {
      sourceId,
      observedAt,
      providerUpdatedAt: latestTimestamp(allUpdatedAts),
      // activeIncidents enumerates every one of Auth0's stable regions on every
      // successful fetch, so a region absent from the payload is genuinely gone.
      componentsComplete: true,
      // The payload authoritatively lists every currently active incident, so an
      // open incident it omits has resolved.
      incidentsComplete: true,
      components,
      incidents,
      maintenances,
      cache: { etag: null, lastModified: null },
    }
  },
}
