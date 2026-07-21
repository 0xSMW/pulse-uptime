// AWS Health adapter. One document, the public currentevents feed, serves
// both current per-service state and the incident prose. It carries only
// ACTIVE events (an empty array means every service is operational), so a
// service with no active event simply has no entry in `components` and callers
// read that absence as OPERATIONAL, exactly like google_cloud_status. There is
// no always-on component roster and no quiet-state taxonomy endpoint, so this
// adapter never enumerates a full service list. The feed is served as
// application/json;charset=utf-16, decoded upstream in fetch.ts before it
// reaches this pure normalizer.

import { z } from "zod"

import type { DependencySourceManifest } from "../manifest"
import type { NormalizedProviderSnapshot } from "../types"
import { scopeFromComponentIds } from "../types"

import type {
  AdapterRequestDescriptor,
  CatalogDirectoryInput,
  DependencyAdapter,
  NormalizeInput,
} from "./index"
import {
  AdapterParseError,
  catalogDirectoryFromNormalize,
  latestTimestamp,
  requireJson,
  toBoundedPlainText,
} from "./shared"

type ComponentState = "OPERATIONAL" | "DEGRADED" | "OUTAGE" | "MAINTENANCE"

const SEVERITY_RANK: Record<ComponentState, number> = {
  OPERATIONAL: 0,
  MAINTENANCE: 1,
  DEGRADED: 2,
  OUTAGE: 3,
}

// AWS status codes, as served in every status field on the feed. 0 operational,
// 1 informational, 2 degraded, 3 disruption. An informational service is shown
// as DEGRADED with its event prose attached rather than hidden, since AWS uses
// it for a real active advisory. A code outside this set fails the document
// loudly (keeps last known state) rather than being guessed at.
function statusCodeToState(
  code: string,
  sourceId: string
): ComponentState | null {
  switch (code) {
    case "0":
      return null
    case "1":
    case "2":
      return "DEGRADED"
    case "3":
      return "OUTAGE"
    default:
      throw new AdapterParseError(
        "UNKNOWN_STATUS",
        `${sourceId}: unrecognized AWS status code "${code}"`
      )
  }
}

const numericTimestamp = z.union([z.number(), z.string()])

/** Epoch seconds (feed `date` and every event_log timestamp) to an ISO string, or throws when the value is not a finite number. */
function epochSecondsToIso(
  value: number | string,
  sourceId: string,
  field: string
): string {
  const seconds = typeof value === "string" ? Number(value) : value
  if (!Number.isFinite(seconds)) {
    throw new AdapterParseError(
      "SCHEMA_INVALID",
      `${sourceId}: invalid epoch seconds for ${field}: "${value}"`
    )
  }
  return new Date(seconds * 1000).toISOString()
}

/** Epoch milliseconds (every impacted_service_status_changes timestamp) to an ISO string, or throws when the value is not a finite number. */
function epochMillisToIso(
  value: number | string,
  sourceId: string,
  field: string
): string {
  const millis = typeof value === "string" ? Number(value) : value
  if (!Number.isFinite(millis)) {
    throw new AdapterParseError(
      "SCHEMA_INVALID",
      `${sourceId}: invalid epoch millis for ${field}: "${value}"`
    )
  }
  return new Date(millis).toISOString()
}

const statusChangeSchema = z.object({
  service: z.string().min(1),
  service_name: z.string().nullable().optional(),
  previous_status: z.string(),
  current_status: z.string(),
  timestamp: numericTimestamp,
})

const impactedServiceSchema = z.object({
  current: z.string(),
  max: z.string().optional(),
  service_name: z.string().nullable().optional(),
})

const eventLogSchema = z.object({
  message: z.string().nullable().optional(),
  status: z.number().nullable().optional(),
  summary: z.string().nullable().optional(),
  timestamp: numericTimestamp,
})

const eventSchema = z.object({
  date: numericTimestamp,
  arn: z.string().min(1),
  region_name: z.string().nullable().optional(),
  status: z.string(),
  service: z.string().min(1),
  service_name: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  event_log: z.array(eventLogSchema).optional().default([]),
  impacted_services: z
    .record(z.string(), impactedServiceSchema)
    .optional()
    .default({}),
  impacted_service_status_changes: z
    .array(statusChangeSchema)
    .optional()
    .default([]),
})

const feedSchema = z.array(eventSchema)

type AwsEvent = z.infer<typeof eventSchema>

/** Human label for an event's severity code, stored as the incident impact. Absence of a match leaves the impact null rather than throwing, since a novel event-level code must not fail an otherwise valid document. */
function impactLabel(code: string): string | null {
  switch (code) {
    case "1":
      return "informational"
    case "2":
      return "degraded"
    case "3":
      return "disruption"
    default:
      return null
  }
}

type StatusChange = z.infer<typeof statusChangeSchema>

/**
 * The single latest impacted_service_status_changes entry per service,
 * reduced by timestamp. impacted_service_status_changes is an append-only log
 * covering the whole event, so a service can appear several times (0->1 then
 * 1->0), and only the newest entry describes its current status. Reducing to
 * the latest per service is what lets a service AWS has already recovered fall
 * back to operational rather than keeping its stale degraded peak. Ties on
 * timestamp keep the last-seen entry, matching the feed's append order.
 */
function latestChangePerService(event: AwsEvent): Map<string, StatusChange> {
  const latest = new Map<string, StatusChange>()
  for (const change of event.impacted_service_status_changes) {
    const existing = latest.get(change.service)
    if (!existing || Number(change.timestamp) >= Number(existing.timestamp)) {
      latest.set(change.service, change)
    }
  }
  return latest
}

/**
 * The service ids this event currently impacts, taken from each service's
 * LATEST impacted_service_status_changes entry where that latest status is not
 * operational. A service AWS has already recovered (latest current_status 0)
 * while the event stays open for others is excluded, mirroring
 * google-cloud-status: an install pinned to a now-recovered service id must not
 * read as still touched by the active event. Resolving per service by latest
 * timestamp, rather than including any non-operational entry across the whole
 * log, is what keeps a 0->1->0 history from surfacing as still degraded. Each
 * id is the feed's own `service` string (ec2-us-east-1, s3-us-east-1, or a bare
 * code for a global service), which is exactly what a component_ids selector
 * pins.
 */
function impactedServiceIds(event: AwsEvent, sourceId: string): string[] {
  const ids: string[] = []
  for (const change of latestChangePerService(event).values()) {
    if (statusCodeToState(change.current_status, sourceId) === null) {
      continue
    }
    ids.push(change.service)
  }
  return ids
}

function mapEvent(
  event: AwsEvent,
  sourceId: string
): NormalizedProviderSnapshot["incidents"][number] {
  const startedAt = epochSecondsToIso(event.date, sourceId, "event.date")
  const updates = event.event_log.map((entry) => {
    const at = epochSecondsToIso(
      entry.timestamp,
      sourceId,
      "event_log.timestamp"
    )
    return {
      // AWS log entries carry no id of their own, and the feed lists them
      // append-only oldest-first, so the entry timestamp is the stable
      // immutable identity across polls.
      externalId: String(entry.timestamp),
      // The feed is active-only with no per-update lifecycle field, so every
      // update reads as identified, matching the active-incident convention.
      state: "identified",
      bodyText: toBoundedPlainText(entry.message),
      createdAt: at,
      updatedAt: at,
    }
  })
  const updatedAt =
    latestTimestamp(updates.map((update) => update.updatedAt)) ?? startedAt
  return {
    externalId: event.arn,
    title: toBoundedPlainText(event.summary) || "AWS service event",
    // Active-only feed, so an event present here is identified, never resolved.
    // Closure happens when the event drops out of the feed entirely, gated by
    // incidentsComplete in persist.ts.
    state: "identified",
    impact: impactLabel(event.status),
    startedAt,
    resolvedAt: null,
    updatedAt,
    canonicalUrl: null,
    // Impacted service ids when present, unmapped when AWS names none.
    scope: scopeFromComponentIds(impactedServiceIds(event, sourceId)),
    updates,
  }
}

export const awsHealthAdapter: DependencyAdapter = {
  requests(source: DependencySourceManifest): AdapterRequestDescriptor[] {
    return [{ kind: "current", url: source.currentUrl, optional: false }]
  },

  catalogDirectory(input: CatalogDirectoryInput) {
    return catalogDirectoryFromNormalize(awsHealthAdapter, input)
  },

  normalize(input: NormalizeInput): NormalizedProviderSnapshot {
    const { source, documents, observedAt } = input
    const document = documents[0]
    const json = requireJson(document, source.id, "currentevents")
    const result = feedSchema.safeParse(json)
    if (!result.success) {
      throw new AdapterParseError(
        "SCHEMA_INVALID",
        `${source.id}: currentevents failed schema validation: ${result.error.message}`
      )
    }
    const events = result.data

    // Each service resolves to the state of its LATEST change within an event,
    // never the worst across the whole append-only log, so a service that went
    // degraded and then recovered inside one still-open event contributes no
    // component entry and reads as operational. worst_of still applies across
    // events for a service that several concurrent events touch, and the latest
    // change's own timestamp is the component updatedAt.
    const components: NormalizedProviderSnapshot["components"] = {}
    for (const event of events) {
      for (const change of latestChangePerService(event).values()) {
        const state = statusCodeToState(change.current_status, source.id)
        if (state === null) {
          continue
        }
        const updatedAt = epochMillisToIso(
          change.timestamp,
          source.id,
          "impacted_service_status_changes.timestamp"
        )
        const existing = components[change.service]
        if (!existing || SEVERITY_RANK[state] > SEVERITY_RANK[existing.state]) {
          components[change.service] = { state, updatedAt }
        }
      }
    }

    const incidents = events.map((event) => mapEvent(event, source.id))
    const providerUpdatedAt = latestTimestamp(
      incidents.map((incident) => incident.updatedAt)
    )

    return {
      sourceId: source.id,
      observedAt,
      providerUpdatedAt,
      // The feed lists only services with an active event, never a full
      // roster, so an absent service id means operational, not missing. This is
      // the one exemption from the UNKNOWN-on-absence rule, shared with
      // google_cloud_status. See resolveDependencyState in persist.ts.
      componentsComplete: false,
      // The currentevents feed is the authoritative set of every open AWS
      // event, and AWS drops an event the moment it resolves rather than
      // marking it resolved in place. So a stored-open incident absent from
      // this snapshot has genuinely ended and may be closed. A truncated or
      // failed fetch never reaches here (it fails in fetch.ts and the source
      // reads UNKNOWN), so absence here is real resolution, not a partial read.
      incidentsComplete: true,
      components,
      incidents,
      maintenances: [],
      cache: { etag: null, lastModified: null },
    }
  },
}
