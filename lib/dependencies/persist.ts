import "server-only"

import { randomUUID } from "node:crypto"

import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm"

import type { Database, DatabaseHandle } from "@/lib/db/client"
import {
  dependencies,
  dependencyCatalog,
  dependencyIncidentMatches,
  dependencySources,
  dependencyState,
  dependencyStateIntervals,
  providerIncidentComponents,
  providerIncidents,
  providerIncidentUpdates,
} from "@/lib/db/schema"
import { enqueueDependencyNotifications } from "@/lib/notifications/enqueue"

import type { PollOutcome } from "./poller"
import type {
  DependencyAdapterName,
  DependencyFidelity,
  DependencySelector,
  DependencyState,
  IncidentMatchScope,
  NormalizedProviderSnapshot,
} from "./types"
import { componentIdsFromScope } from "./types"

// One transaction per source: upsert provider incidents and their updates
// and components, recompute every installed dependency's state from its
// catalog selector, close/open state intervals only on change, write
// dependency_incident_matches, enqueue the notification outbox, and update
// source health. Every write here is either idempotent (ON CONFLICT DO
// NOTHING) or conditional-on-change, so repeated polls of unchanged upstream
// data append nothing: the concurrency and idempotency tests lean on this.

type ComponentishState = "OPERATIONAL" | "DEGRADED" | "OUTAGE" | "MAINTENANCE"
type NormalizedIncident = NormalizedProviderSnapshot["incidents"][number]

const STATE_RANK: Record<ComponentishState, number> = {
  OPERATIONAL: 0,
  MAINTENANCE: 1,
  DEGRADED: 2,
  OUTAGE: 3,
}
const BACKOFF_MINUTES = [5, 15, 30]

export function worstOf(
  states: readonly ComponentishState[]
): ComponentishState {
  if (states.length === 0) {
    return "OPERATIONAL"
  }
  return states.reduce((worst, state) =>
    STATE_RANK[state] > STATE_RANK[worst] ? state : worst
  )
}

/**
 * Component states with active maintenance windows folded in. A component
 * with no active incident and no active maintenance defaults to
 * OPERATIONAL; maintenance only raises a component that would otherwise be
 * OPERATIONAL, it never masks a worse reported state.
 */
export function combinedComponentStates(
  snapshot: NormalizedProviderSnapshot
): Map<string, ComponentishState> {
  const map = new Map<string, ComponentishState>()
  for (const [id, component] of Object.entries(snapshot.components)) {
    map.set(id, component.state)
  }

  const observedAt = new Date(snapshot.observedAt)
  for (const maintenance of snapshot.maintenances) {
    if (maintenance.state === "completed") {
      continue
    }
    const startsAt = new Date(maintenance.startsAt)
    const endsAt = maintenance.endsAt ? new Date(maintenance.endsAt) : null
    if (startsAt > observedAt || (endsAt && endsAt < observedAt)) {
      continue
    }
    for (const componentId of maintenance.componentIds) {
      const existing = map.get(componentId)
      if (!existing || STATE_RANK.MAINTENANCE > STATE_RANK[existing]) {
        map.set(componentId, "MAINTENANCE")
      }
    }
  }
  return map
}

/**
 * The upstream ids that identify this dependency for both state lookup and
 * incident-component intersection. All three scoped selectors fold in an
 * extra id here purely for matching, not for the scoped state lookup.
 * Google's location-scoped composite (productId@locationId) only ever
 * appears in the incident's components scope, never in the components state
 * map (see google-cloud-status.ts). A scoped statusio container's parent
 * componentId
 * aggregates the worst state across every sibling region container, so an
 * incident naming the parent still associates, but the scoped install's own
 * severity comes from the container alone (see resolveDependencyState). A
 * scoped component_ids install (a discovered_children preset) keeps its
 * parent aggregate ids here for matching an incident that names the parent,
 * while its severity likewise comes from the scope child alone.
 */
export function matchingIdsForSelector(
  selector: DependencySelector,
  scopeId: string | null
): string[] {
  switch (selector.kind) {
    case "component_ids":
      return scopeId ? [...selector.ids, scopeId] : [...selector.ids]
    case "statusio_component_container":
      return scopeId ? [selector.componentId, scopeId] : [selector.componentId]
    case "google_product":
      return scopeId
        ? [selector.productId, `${selector.productId}@${scopeId}`]
        : [selector.productId]
  }
}

/**
 * Resolves one dependency's state from its selector. Three scoped selectors
 * resolve their severity outside the shared worst_of path.
 *
 * A scoped component_ids install's ids name the parent group aggregate,
 * which folds in the worst state across every sibling child, so its severity
 * comes from the scope child alone rather than worst_of'ing the parent
 * aggregate in. Otherwise a sibling region's outage on the shared parent
 * would surface against a child that is actually fine. The parent still
 * participates in matching (see matchingIdsForSelector).
 *
 * Google's location scope can't use combinedComponentStates directly: the
 * adapter never stores a per-location component state, only a per-location
 * composite id on incidents (see google-cloud-status.ts), so a scoped Google
 * product's severity is approximated from the product's bare aggregate
 * state, gated on whether an active incident actually names this location.
 * This is a documented approximation, not a precise per-location severity,
 * since the normalized snapshot has no other way to carry it.
 *
 * A scoped statusio container has its own entry in the components state map
 * keyed by the container id (see statusio-public.ts), so its severity is the
 * container's own state alone. The parent componentId aggregates the worst
 * state across every sibling region container, so worst_of'ing it in would
 * report a different region's outage against a container that is actually
 * fine. The parent still participates in matching (see
 * matchingIdsForSelector), just not in this scoped state lookup.
 *
 * A selector id absent from `combined` means UNKNOWN when the snapshot's
 * componentsComplete flag is true (the feed enumerated every component and
 * simply doesn't have this one anymore), otherwise OPERATIONAL (only
 * google_cloud_status sets componentsComplete false, since its feed only
 * ever lists products with an active incident). worst_of still applies
 * across every id that IS present; an absent id under a complete feed short
 * circuits the whole dependency to UNKNOWN.
 */
export function resolveDependencyState(
  selector: DependencySelector,
  scopeId: string | null,
  combined: ReadonlyMap<string, ComponentishState>,
  snapshot: NormalizedProviderSnapshot
): DependencyState {
  const fallback = (): DependencyState =>
    snapshot.componentsComplete ? "UNKNOWN" : "OPERATIONAL"

  if (selector.kind === "google_product" && scopeId) {
    const compositeKey = `${selector.productId}@${scopeId}`
    const touchedByActiveIncident = snapshot.incidents.some(
      (incident) =>
        incident.resolvedAt === null &&
        componentIdsFromScope(incident.scope).includes(compositeKey)
    )
    if (!touchedByActiveIncident) {
      return "OPERATIONAL"
    }
    return combined.get(selector.productId) ?? fallback()
  }

  if (selector.kind === "statusio_component_container" && scopeId) {
    return combined.get(scopeId) ?? fallback()
  }

  if (selector.kind === "component_ids" && scopeId) {
    return combined.get(scopeId) ?? fallback()
  }

  const ids = matchingIdsForSelector(selector, scopeId)
  const states: ComponentishState[] = []
  for (const id of ids) {
    const state = combined.get(id)
    if (state) {
      states.push(state)
      continue
    }
    if (snapshot.componentsComplete) {
      return "UNKNOWN"
    }
    states.push("OPERATIONAL")
  }
  return worstOf(states)
}

/** incidentio_compat incidents never carry an explicit component list (see incidentio-compat.ts); every other launch adapter's componentIds are explicit provider data. */
export function associationKindForAdapter(
  adapter: DependencyAdapterName
): "explicit" | "inferred" {
  return adapter === "incidentio_compat" ? "inferred" : "explicit"
}

export function selectorIntersectsIncident(
  selector: DependencySelector,
  scopeId: string | null,
  incidentComponentIds: readonly string[]
): boolean {
  const ids = new Set(matchingIdsForSelector(selector, scopeId))
  return incidentComponentIds.some((id) => ids.has(id))
}

/** A stored provider incident considered for install-time backfill, with its component associations already gathered. */
export interface BackfillIncidentCandidate {
  incidentId: string
  componentIds: readonly string[]
  startedAt: Date
  resolvedAt: Date | null
}

/**
 * Selects which of a source's incidents to link to a freshly installed
 * dependency so its timeline and incident list show real recent history
 * instead of a fully grey window. A candidate qualifies only when it is
 * already resolved, its active window [startedAt, resolvedAt] intersects the
 * trailing 7 days [windowStart, now], and its component associations intersect
 * the install's selector.
 *
 * Active incidents are deliberately excluded: the install schedules an
 * immediate poll, and that poll opens their match and fires the opening
 * notification through the normal transition path. Backfilling them here would
 * pre-create the match and suppress that notification.
 *
 * This is the one place that relaxes the poll path's no-install-time-broaden
 * rule, and only for resolved component-scoped incidents. Source-wide and
 * unmapped incidents persist no component rows, so they never intersect and
 * stay unmatched, exactly as the poll path leaves them for a new install.
 */
export function selectBackfillIncidentIds(
  selector: DependencySelector,
  scopeId: string | null,
  candidates: readonly BackfillIncidentCandidate[],
  windowStart: Date,
  now: Date
): string[] {
  const windowStartMs = windowStart.getTime()
  const nowMs = now.getTime()
  const ids: string[] = []
  for (const candidate of candidates) {
    if (candidate.resolvedAt === null) {
      continue
    }
    if (
      candidate.startedAt.getTime() > nowMs ||
      candidate.resolvedAt.getTime() < windowStartMs
    ) {
      continue
    }
    if (selectorIntersectsIncident(selector, scopeId, candidate.componentIds)) {
      ids.push(candidate.incidentId)
    }
  }
  return ids
}

const BACKFILL_WINDOW_MS = 7 * 86_400_000

/**
 * Links a newly installed dependency to the source's recent resolved incidents
 * so its timeline and incident list carry real history from the moment it is
 * added, rather than a fully grey pre-install window. Runs on the caller's
 * insert transaction so the matches commit atomically with the dependency.
 * Returns the number of matches created.
 *
 * Only resolved component-scoped incidents in the trailing 7 days that
 * intersect this install's selector are linked (see selectBackfillIncidentIds).
 * The match rows are created with ON CONFLICT DO NOTHING and the poll path
 * never prunes matches, so an immediate first poll neither duplicates nor
 * removes them.
 */
export async function backfillResolvedIncidentMatches(
  tx: DatabaseHandle,
  params: {
    dependencyId: string
    catalogId: string
    sourceId: string
    scopeId: string | null
    now: Date
  }
): Promise<number> {
  const windowStart = new Date(params.now.getTime() - BACKFILL_WINDOW_MS)

  const [preset] = await tx
    .select({
      selector: dependencyCatalog.selector,
      adapter: dependencySources.adapter,
    })
    .from(dependencyCatalog)
    .innerJoin(
      dependencySources,
      eq(dependencySources.id, dependencyCatalog.sourceId)
    )
    .where(eq(dependencyCatalog.id, params.catalogId))
    .limit(1)
  if (!preset) {
    return 0
  }
  const selector = preset.selector as DependencySelector
  const adapter = preset.adapter as DependencyAdapterName

  // Resolved incidents in the trailing 7 days joined to their component
  // associations. A resolved_at >= windowStart comparison also drops open
  // incidents (null resolved_at never satisfies it), and the inner join drops
  // source-wide and unmapped incidents, which persist no component rows.
  const rows = await tx
    .select({
      incidentId: providerIncidents.id,
      startedAt: providerIncidents.startedAt,
      resolvedAt: providerIncidents.resolvedAt,
      componentId: providerIncidentComponents.externalComponentId,
    })
    .from(providerIncidents)
    .innerJoin(
      providerIncidentComponents,
      eq(providerIncidentComponents.incidentId, providerIncidents.id)
    )
    .where(
      and(
        eq(providerIncidents.sourceId, params.sourceId),
        gte(providerIncidents.resolvedAt, windowStart)
      )
    )
  if (rows.length === 0) {
    return 0
  }

  const componentsByIncident = new Map<string, string[]>()
  const metaByIncident = new Map<
    string,
    { startedAt: Date; resolvedAt: Date | null }
  >()
  for (const row of rows) {
    const list = componentsByIncident.get(row.incidentId) ?? []
    list.push(row.componentId)
    componentsByIncident.set(row.incidentId, list)
    if (!metaByIncident.has(row.incidentId)) {
      metaByIncident.set(row.incidentId, {
        startedAt: row.startedAt,
        resolvedAt: row.resolvedAt,
      })
    }
  }
  const candidates: BackfillIncidentCandidate[] = [
    ...componentsByIncident.entries(),
  ].map(([incidentId, componentIds]) => {
    const meta = metaByIncident.get(incidentId)
    return {
      incidentId,
      componentIds,
      startedAt: meta?.startedAt ?? params.now,
      resolvedAt: meta?.resolvedAt ?? null,
    }
  })

  const matchIds = selectBackfillIncidentIds(
    selector,
    params.scopeId,
    candidates,
    windowStart,
    params.now
  )
  if (matchIds.length === 0) {
    return 0
  }

  const matchKind: "component_match" | "inferred" =
    associationKindForAdapter(adapter) === "inferred"
      ? "inferred"
      : "component_match"
  await tx
    .insert(dependencyIncidentMatches)
    .values(
      matchIds.map((incidentId) => ({
        dependencyId: params.dependencyId,
        incidentId,
        matchKind,
        matchedAt: params.now,
      }))
    )
    .onConflictDoNothing()
  return matchIds.length
}

/**
 * Opening-notification eligibility. Scope controls whether a new open alert
 * is allowed. Match rows may still be written for correlation when the gate
 * declines the notification.
 *
 * - source: eligible at any dependency state
 * - components: eligible only when this dependency is non-operational
 * - unmapped: never opens a new match or notification
 */
export function shouldNotifyDependencyIncident(
  scope: IncidentMatchScope,
  nextState: DependencyState
): boolean {
  if (scope.kind === "source") {
    return true
  }
  if (scope.kind === "unmapped") {
    return false
  }
  return (
    nextState === "DEGRADED" ||
    nextState === "OUTAGE" ||
    nextState === "MAINTENANCE"
  )
}

/**
 * Recovery-notification eligibility. Fidelity plus the dependency's final
 * resolved state control recovery. Scope does not: it only governs matching
 * and opening. Both terminal-state and disappearance closure paths use this.
 *
 * - component fidelity: eligible only at OPERATIONAL
 * - incident_only fidelity: eligible at UNKNOWN or OPERATIONAL
 * - DEGRADED / OUTAGE / MAINTENANCE always defers recovery
 */
export function shouldNotifyDependencyRecovery(
  fidelity: DependencyFidelity,
  resolvedState: DependencyState
): boolean {
  if (
    resolvedState === "DEGRADED" ||
    resolvedState === "OUTAGE" ||
    resolvedState === "MAINTENANCE"
  ) {
    return false
  }
  if (fidelity === "incident_only") {
    return resolvedState === "UNKNOWN" || resolvedState === "OPERATIONAL"
  }
  return resolvedState === "OPERATIONAL"
}

/**
 * Notification events are derived from the incident's observed state
 * TRANSITION, not from match-row newness alone. `priorResolvedAt` is the
 * incident's resolved_at as stored before this poll's upserts touch it:
 * `undefined` means the incident row did not exist yet (never observed by
 * this source before this poll), `null` means it existed and was open, and a
 * Date means it existed and was already resolved.
 *
 * "incident" fires whenever the incident is observed active (resolved_at
 * null) and this poll is a transition into a matched-active state, which is
 * true in exactly two ways regardless of whether the match row is new or
 * old. Either the dependency is matched to an incident that was open, or new
 * this poll, and not already known-resolved (a fresh active match), or the
 * incident was stored resolved as of the prior poll and is now active again
 * (a reopen). A reopen fires whether the match row already existed from an
 * earlier cycle or was first created against the reopened incident on this
 * poll. The one active case that fires nothing is an unchanged still-open
 * match: the incident was already open as of the prior poll (priorResolvedAt
 * null) and the match row is not new, so no transition happened. A match
 * created against an already-resolved incident (isActive false: a historical
 * incident found on install, or one that opened and closed within a single
 * poll gap) is backfill, not a transition, and never fires "incident".
 *
 * "recovery" fires only on the poll where the incident is observed resolved
 * for the first time: the incident must have existed before this poll with
 * resolved_at still null. An incident that was already resolved as of the
 * prior poll never fires recovery again, regardless of whether a match row
 * for this dependency is new or old, and regardless of the outbox's own
 * idempotency keys. A later reopen-then-resolve cycle for the same external
 * id fires recovery again the same way, since at that poll resolved_at is
 * again observed transitioning from open (null) to resolved.
 */
export function deriveNotificationEvent(
  isNewMatch: boolean,
  isActive: boolean,
  priorResolvedAt: Date | null | undefined
): "incident" | "recovery" | null {
  const priorKnownResolved =
    priorResolvedAt !== undefined && priorResolvedAt !== null
  if (isActive) {
    return isNewMatch || priorKnownResolved ? "incident" : null
  }
  if (priorResolvedAt === null) {
    return "recovery"
  }
  return null
}

/**
 * The external id value threaded into a notification's idempotency key
 * (dependencyNotificationKey), kept separate from the incident's own
 * external id used for storage and matching. A first-time "incident" event
 * (isReopen false) carries the bare external id unchanged, so an
 * already-enqueued row for it keeps deduplicating exactly as before. A
 * reopen "incident" event (isReopen true: the incident was stored resolved
 * as of the prior poll and is now active again, whether the match row is new
 * this poll or predates the resolution) appends the timestamp of the
 * resolution the reopen transitioned away from, since that timestamp is
 * stable across polls and retries of the same reopen. A "recovery" event
 * always appends the resolvedAt timestamp reported for that resolution, so
 * a later reopen-then-resolve cycle's recovery mints a key distinct from an
 * earlier cycle's recovery instead of colliding with it.
 */
export function notificationKeyExternalId(
  event: "incident" | "recovery",
  incidentExternalId: string,
  isReopen: boolean,
  priorResolvedAt: Date | null | undefined,
  resolvedAt: string | null
): string {
  if (event === "incident") {
    return isReopen && priorResolvedAt
      ? `${incidentExternalId}#${priorResolvedAt.getTime()}`
      : incidentExternalId
  }
  return resolvedAt
    ? `${incidentExternalId}#${new Date(resolvedAt).getTime()}`
    : incidentExternalId
}

/** Upper bound on provider Retry-After delays used for next_poll_at. */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * Retry-After wins when it is a finite nonnegative delay at most 24h.
 * Invalid or oversized values fall through to the fixed 5/15/30 minute ladder,
 * indexed by how many consecutive failures this is.
 */
export function failureDelayMs(
  consecutiveFailures: number,
  retryAfterMs: number | null
): number {
  if (
    retryAfterMs !== null &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0 &&
    retryAfterMs <= MAX_RETRY_AFTER_MS
  ) {
    return retryAfterMs
  }
  const index = Math.min(
    Math.max(consecutiveFailures - 1, 0),
    BACKOFF_MINUTES.length - 1
  )
  return BACKOFF_MINUTES[index]! * 60_000
}

export function isSourceStale(
  lastSuccessAt: Date | null,
  staleAfterSeconds: number,
  now: Date
): boolean {
  if (!lastSuccessAt) {
    return true
  }
  return now.getTime() - lastSuccessAt.getTime() > staleAfterSeconds * 1000
}

export function computeNextPollAt(
  allOperational: boolean,
  source: { operationalPollSeconds: number; activePollSeconds: number },
  now: Date
): Date {
  return new Date(
    now.getTime() +
      (allOperational
        ? source.operationalPollSeconds
        : source.activePollSeconds) *
        1000
  )
}

// -- Executor interface -------------------------------------------------

export interface PersistSourceRow {
  id: string
  provider: string
  adapter: DependencyAdapterName
  statusPageUrl: string
  allowedHosts: readonly string[]
  operationalPollSeconds: number
  activePollSeconds: number
  staleAfterSeconds: number
  consecutiveFailures: number
  lastSuccessAt: Date | null
}

/**
 * Only ever returns a provider-supplied URL when it parses as https and its
 * host is allowlisted for the source (or is the source's own status page
 * host); otherwise falls back to the source's status page. Applied before a
 * canonical URL is written to provider_incidents or put in a notification
 * payload, so neither the dashboard nor an email ever renders an
 * unvalidated href, e.g. a javascript: URL or an attacker-controlled host.
 */
export function safeProviderUrl(
  rawUrl: string | null,
  source: { statusPageUrl: string; allowedHosts: readonly string[] }
): string {
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl)
      if (parsed.protocol === "https:") {
        const statusHost = new URL(source.statusPageUrl).hostname
        if (
          parsed.hostname === statusHost ||
          source.allowedHosts.includes(parsed.hostname)
        ) {
          return rawUrl
        }
      }
    } catch {
      // Falls through to the status page below.
    }
  }
  return source.statusPageUrl
}

export interface InstalledDependencyRow {
  id: string
  catalogId: string
  presetName: string
  scopeId: string | null
  selector: DependencySelector
  /** Catalog fidelity for this install. Drives recovery eligibility. */
  fidelity: DependencyFidelity
  notificationsEnabled: boolean
  currentState: DependencyState
}

export interface DependencyNotificationInput {
  event: "incident" | "recovery"
  sourceId: string
  dependencyId: string
  presetId: string
  scopeId: string | null
  dependencyName: string
  provider: string
  /** The idempotency-key external id (see notificationKeyExternalId), not necessarily the incident's bare external id. */
  incidentExternalId: string
  incidentTitle: string
  state: string
  canonicalUrl: string | null
  providerTimestamp: string
  recipients: readonly string[]
}

export interface PersistExecutor {
  loadInstalledDependencies: (
    sourceId: string
  ) => Promise<InstalledDependencyRow[]>
  /**
   * Batched read of resolved_at for this source's incidents, keyed by
   * external id, as stored before this poll's upserts touch them. Read once
   * up front so the event-transition check below compares against a stable
   * prior state rather than the row this same poll just wrote. A missing key
   * means the incident row did not exist before this poll.
   */
  loadPriorIncidentResolution: (
    sourceId: string,
    externalIds: readonly string[]
  ) => Promise<Map<string, Date | null>>
  /**
   * Existing (dependencyId, incidentId) pairs already recorded in
   * dependency_incident_matches for these incident internal ids, as a
   * `${dependencyId}:${incidentId}` key set. Used for unmapped and resolved
   * source scopes (no new broad match), and for component-scoped incidents
   * whose provider no longer lists a previously matched id.
   */
  loadExistingMatches: (incidentIds: readonly string[]) => Promise<Set<string>>
  /**
   * This source's currently stored-open incidents (resolved_at is null), with
   * just enough of each to close it and fire recovery. Read only under a
   * snapshot whose incidentsComplete flag is true, so a stored-open incident
   * absent from the snapshot can be closed as resolved.
   */
  loadOpenIncidents: (sourceId: string) => Promise<
    Array<{
      internalId: string
      externalId: string
      title: string
      canonicalUrl: string | null
    }>
  >
  /** Sets resolved_at (and state resolved, provider_updated_at) on a stored-open incident whose external id vanished from a complete snapshot. */
  closeIncident: (internalId: string, resolvedAt: Date) => Promise<void>
  /** Upsert on (source_id, external_id); updates in place only when provider_updated_at actually advanced. Returns the incident's internal id either way. */
  upsertIncident: (
    sourceId: string,
    candidateId: string,
    incident: NormalizedIncident
  ) => Promise<string>
  /** New (incidentId, externalComponentId) pairs only; existing pairs are left untouched. */
  upsertIncidentComponents: (
    incidentId: string,
    componentIds: readonly string[],
    associationKind: "explicit" | "inferred"
  ) => Promise<void>
  /**
   * Monotonic upsert of provider update rows, keyed by provider identity
   * (incident_id, external_update_id). Rows are snapshots of the provider's
   * current view of that update, not append-only events: a newer
   * provider_updated_at overwrites state and body, a same-timestamp correction
   * applies when a material field differs, and older snapshots are ignored.
   * Earliest provider_created_at is preserved. Identical replay is a no-op.
   */
  upsertIncidentUpdates: (
    incidentId: string,
    updates: NormalizedIncident["updates"]
  ) => Promise<void>
  /**
   * New (dependencyId, incidentId) pairs only; a match, once recorded, is
   * never removed even if the provider later disassociates the component.
   * Returns true only when this call newly inserted the row (INSERT ...
   * ON CONFLICT DO NOTHING RETURNING), false when the pair already existed:
   * combined with the incident's prior resolved_at, this tells "just started
   * matching" apart from "still matching, same as last poll".
   */
  upsertDependencyIncidentMatch: (
    dependencyId: string,
    incidentId: string,
    matchKind: "component_match" | "inferred",
    now: Date
  ) => Promise<boolean>
  /**
   * Updates dependency_state in place always; closes/opens
   * dependency_state_intervals only when state changed from previousState.
   * Advances last_successful_poll_at to now only when pollSucceeded is true
   * (a real snapshot). A stale-failure flip to UNKNOWN passes false, so the
   * dashboard's "Last Successful Feed Check" keeps the last real success
   * rather than showing the failure time.
   */
  applyDependencyState: (
    dependencyId: string,
    previousState: DependencyState,
    next: {
      state: DependencyState
      observedAt: Date
      providerUpdatedAt: Date | null
      pollSucceeded: boolean
    },
    now: Date
  ) => Promise<void>
  enqueueNotification: (
    input: DependencyNotificationInput,
    now: Date
  ) => Promise<number>
  updateSourceHealthSuccess: (
    sourceId: string,
    patch: {
      etag: string | null
      lastModified: string | null
      nextPollAt: Date
      now: Date
    }
  ) => Promise<void>
  updateSourceHealthNotModified: (
    sourceId: string,
    patch: {
      etag: string | null
      lastModified: string | null
      nextPollAt: Date
      now: Date
    }
  ) => Promise<void>
  updateSourceHealthFailure: (
    sourceId: string,
    patch: {
      errorCode: string
      consecutiveFailures: number
      nextPollAt: Date
      now: Date
    }
  ) => Promise<void>
}

export interface PersistStore {
  transaction: <T>(work: (tx: PersistExecutor) => Promise<T>) => Promise<T>
}

export interface PersistContext {
  now: Date
  defaultRecipients: readonly string[]
}

export interface PersistSummary {
  dependenciesEvaluated: number
  incidentsUpserted: number
  notificationsEnqueued: number
  flippedToUnknown: number
}

const EMPTY_SUMMARY: PersistSummary = {
  dependenciesEvaluated: 0,
  incidentsUpserted: 0,
  notificationsEnqueued: 0,
  flippedToUnknown: 0,
}

async function applyAllOperationalNextPoll(
  tx: PersistExecutor,
  source: PersistSourceRow,
  states: ReadonlyMap<string, DependencyState>,
  outcomeCache: { etag: string | null; lastModified: string | null },
  now: Date,
  kind: "snapshot" | "not_modified"
): Promise<void> {
  const allOperational = [...states.values()].every(
    (state) => state === "OPERATIONAL"
  )
  const nextPollAt = computeNextPollAt(allOperational, source, now)
  const patch = {
    etag: outcomeCache.etag,
    lastModified: outcomeCache.lastModified,
    nextPollAt,
    now,
  }
  if (kind === "snapshot") {
    await tx.updateSourceHealthSuccess(source.id, patch)
  } else {
    await tx.updateSourceHealthNotModified(source.id, patch)
  }
}

export async function persistSnapshot(
  store: PersistStore,
  outcome: PollOutcome,
  source: PersistSourceRow,
  context: PersistContext
): Promise<PersistSummary> {
  return store.transaction(async (tx) => {
    if (outcome.kind === "not_modified") {
      const installed = await tx.loadInstalledDependencies(source.id)
      const states = new Map(
        installed.map(
          (dependency) => [dependency.id, dependency.currentState] as const
        )
      )
      await applyAllOperationalNextPoll(
        tx,
        source,
        states,
        outcome,
        context.now,
        "not_modified"
      )
      return EMPTY_SUMMARY
    }

    if (outcome.kind === "failure") {
      const consecutiveFailures = source.consecutiveFailures + 1
      const nextPollAt = new Date(
        context.now.getTime() +
          failureDelayMs(consecutiveFailures, outcome.retryAfterMs)
      )
      const errorCode = errorCodeOf(outcome.error)
      await tx.updateSourceHealthFailure(source.id, {
        errorCode,
        consecutiveFailures,
        nextPollAt,
        now: context.now,
      })

      let flippedToUnknown = 0
      if (
        isSourceStale(
          source.lastSuccessAt,
          source.staleAfterSeconds,
          context.now
        )
      ) {
        const installed = await tx.loadInstalledDependencies(source.id)
        for (const dependency of installed) {
          if (dependency.currentState === "UNKNOWN") {
            continue
          }
          await tx.applyDependencyState(
            dependency.id,
            dependency.currentState,
            {
              state: "UNKNOWN",
              observedAt: context.now,
              providerUpdatedAt: null,
              pollSucceeded: false,
            },
            context.now
          )
          flippedToUnknown += 1
        }
      }
      return { ...EMPTY_SUMMARY, flippedToUnknown }
    }

    // outcome.kind === "snapshot"
    const { snapshot } = outcome
    const combined = combinedComponentStates(snapshot)
    const associationKind = associationKindForAdapter(source.adapter)

    // Sanitize every incident's canonicalUrl once, up front: the same safe
    // value is what gets persisted to provider_incidents and what travels
    // into a notification payload, so neither the dashboard nor an email
    // ever renders an unvalidated provider-supplied href.
    // Clamp resolvedAt to startedAt in the same pass: providers publish
    // inconsistent timestamps (Cloudflare has shipped a resolved_at hours
    // before its own started_at), and an unclamped pair trips the
    // provider_incidents_resolution_order check, aborting the whole poll on
    // one malformed historical incident. closeIncident applies the same
    // guard for incidents resolved by disappearance.
    const incidents = snapshot.incidents.map((incident) => ({
      ...incident,
      canonicalUrl: safeProviderUrl(incident.canonicalUrl, source),
      resolvedAt:
        incident.resolvedAt &&
        new Date(incident.resolvedAt) < new Date(incident.startedAt)
          ? incident.startedAt
          : incident.resolvedAt,
    }))

    // Read every one of this poll's incidents' prior resolved_at before any
    // upsert below overwrites it, so the transition check further down
    // compares against the state as of the last poll, not this one.
    const priorIncidentResolution = await tx.loadPriorIncidentResolution(
      source.id,
      incidents.map((incident) => incident.externalId)
    )

    let incidentsUpserted = 0
    const incidentInternalIds = new Map<string, string>()
    for (const incident of incidents) {
      const internalId = await tx.upsertIncident(
        source.id,
        randomUUID(),
        incident
      )
      incidentInternalIds.set(incident.externalId, internalId)
      // Component association rows only for components-scoped incidents.
      // Source and unmapped scopes persist no component rows.
      await tx.upsertIncidentComponents(
        internalId,
        componentIdsFromScope(incident.scope),
        associationKind
      )
      await tx.upsertIncidentUpdates(internalId, incident.updates)
      incidentsUpserted += 1
    }

    // Load durable match rows for every incident in this snapshot. Unmapped
    // and resolved source scopes, plus components whose provider dropped a
    // former id, fall back to these rows for correlation and recovery.
    const allIncidentInternalIds = [...incidentInternalIds.values()]
    const existingMatches = await tx.loadExistingMatches(allIncidentInternalIds)

    const installed = await tx.loadInstalledDependencies(source.id)
    const finalStates = new Map<string, DependencyState>()
    let notificationsEnqueued = 0

    for (const dependency of installed) {
      const nextState = resolveDependencyState(
        dependency.selector,
        dependency.scopeId,
        combined,
        snapshot
      )
      finalStates.set(dependency.id, nextState)
      await tx.applyDependencyState(
        dependency.id,
        dependency.currentState,
        {
          state: nextState,
          observedAt: context.now,
          providerUpdatedAt: snapshot.providerUpdatedAt
            ? new Date(snapshot.providerUpdatedAt)
            : null,
          pollSucceeded: true,
        },
        context.now
      )

      for (const incident of incidents) {
        const incidentInternalId = incidentInternalIds.get(incident.externalId)
        if (!incidentInternalId) {
          continue
        }

        const isActive = incident.resolvedAt === null
        const matchKey = `${dependency.id}:${incidentInternalId}`
        const hasExistingMatch = existingMatches.has(matchKey)

        // Match by explicit scope. Empty component arrays never stand alone.
        let isNewMatch: boolean
        switch (incident.scope.kind) {
          // biome-ignore lint/suspicious/noUnnecessaryConditions: reachable at runtime, biome cannot resolve the scope discriminated union
          case "components": {
            // Active and resolved: intersect current ids. When the provider
            // no longer lists a former id, keep the durable match row.
            if (
              selectorIntersectsIncident(
                dependency.selector,
                dependency.scopeId,
                incident.scope.componentIds
              )
            ) {
              const matchKind =
                associationKind === "inferred" ? "inferred" : "component_match"
              isNewMatch = await tx.upsertDependencyIncidentMatch(
                dependency.id,
                incidentInternalId,
                matchKind,
                context.now
              )
              if (isNewMatch) {
                existingMatches.add(matchKey)
              }
            } else if (hasExistingMatch) {
              isNewMatch = false
            } else {
              continue
            }
            break
          }
          // biome-ignore lint/suspicious/noUnnecessaryConditions: reachable at runtime, biome cannot resolve the scope discriminated union
          case "source": {
            if (isActive) {
              // Active source-wide: every installed dependency matches.
              isNewMatch = await tx.upsertDependencyIncidentMatch(
                dependency.id,
                incidentInternalId,
                "inferred",
                context.now
              )
              if (isNewMatch) {
                existingMatches.add(matchKey)
              }
            } else if (hasExistingMatch) {
              // Resolved source-wide: existing matches only (no install-time broaden).
              isNewMatch = false
            } else {
              continue
            }
            break
          }
          // biome-ignore lint/suspicious/noUnnecessaryConditions: reachable at runtime, biome cannot resolve the scope discriminated union
          case "unmapped": {
            // Preserve existing matches only. Never create a new match or
            // open notification from unavailable scope.
            if (!hasExistingMatch) {
              continue
            }
            isNewMatch = false
            break
          }
        }

        // The event is derived from the incident's observed state transition
        // (see deriveNotificationEvent), using resolved_at as it stood
        // before this poll's own upserts. This makes the event fire exactly
        // once at transition time and holds even across an outbox purge,
        // since nothing here depends on a previously enqueued outbox row.
        const priorResolvedAt = priorIncidentResolution.get(incident.externalId)
        const event = deriveNotificationEvent(
          isNewMatch,
          isActive,
          priorResolvedAt
        )
        if (event === null) {
          continue
        }

        // Opening: scope + dependency state. Correlation may already be written.
        if (
          event === "incident" &&
          !shouldNotifyDependencyIncident(incident.scope, nextState)
        ) {
          continue
        }

        // Recovery: fidelity + final dependency state. Scope no longer exempts.
        if (
          event === "recovery" &&
          !shouldNotifyDependencyRecovery(dependency.fidelity, nextState)
        ) {
          continue
        }

        if (
          !dependency.notificationsEnabled ||
          context.defaultRecipients.length === 0
        ) {
          continue
        }

        // An "incident" event on an incident that was stored resolved as of
        // the prior poll is the reopen case, regardless of whether the match
        // row is new this poll or predates the resolution: give it, and every
        // "recovery", a key distinct from the cycle that first used this
        // external id (see notificationKeyExternalId).
        const priorKnownResolved =
          priorResolvedAt !== undefined && priorResolvedAt !== null
        const isReopen = event === "incident" && priorKnownResolved
        const keyExternalId = notificationKeyExternalId(
          event,
          incident.externalId,
          isReopen,
          priorResolvedAt,
          incident.resolvedAt
        )

        const enqueued = await tx.enqueueNotification(
          {
            event,
            sourceId: source.id,
            dependencyId: dependency.id,
            presetId: dependency.catalogId,
            scopeId: dependency.scopeId,
            dependencyName: dependency.presetName,
            provider: source.provider,
            incidentExternalId: keyExternalId,
            incidentTitle: incident.title,
            state: nextState,
            canonicalUrl: incident.canonicalUrl,
            providerTimestamp: incident.updatedAt,
            recipients: context.defaultRecipients,
          },
          context.now
        )
        notificationsEnqueued += enqueued
      }
    }

    // Close any of this source's stored-open incidents whose external id
    // vanished from the snapshot, but only when the snapshot authoritatively
    // enumerates every open incident (incidentsComplete). Without that gate a
    // possibly-incomplete fetch could read a still-open incident's temporary
    // absence as resolution. A closed incident fires recovery for every
    // dependency it still matched, through the same fidelity helper the main
    // loop uses for terminal-state recovery.
    if (snapshot.incidentsComplete) {
      const snapshotExternalIds = new Set(
        incidents.map((incident) => incident.externalId)
      )
      const openStored = await tx.loadOpenIncidents(source.id)
      const disappeared = openStored.filter(
        (open) => !snapshotExternalIds.has(open.externalId)
      )
      if (disappeared.length > 0) {
        const matchesForDisappeared = await tx.loadExistingMatches(
          disappeared.map((open) => open.internalId)
        )
        for (const open of disappeared) {
          await tx.closeIncident(open.internalId, context.now)
          for (const dependency of installed) {
            if (
              !matchesForDisappeared.has(`${dependency.id}:${open.internalId}`)
            ) {
              continue
            }
            if (
              !dependency.notificationsEnabled ||
              context.defaultRecipients.length === 0
            ) {
              continue
            }
            // Same recovery policy as the terminal-state path: fidelity +
            // the dependency's final state after this poll's evaluation.
            const resolvedState =
              finalStates.get(dependency.id) ?? dependency.currentState
            if (
              !shouldNotifyDependencyRecovery(
                dependency.fidelity,
                resolvedState
              )
            ) {
              continue
            }
            const keyExternalId = notificationKeyExternalId(
              "recovery",
              open.externalId,
              false,
              null,
              context.now.toISOString()
            )
            const enqueued = await tx.enqueueNotification(
              {
                event: "recovery",
                sourceId: source.id,
                dependencyId: dependency.id,
                presetId: dependency.catalogId,
                scopeId: dependency.scopeId,
                dependencyName: dependency.presetName,
                provider: source.provider,
                incidentExternalId: keyExternalId,
                incidentTitle: open.title,
                state: resolvedState,
                canonicalUrl: open.canonicalUrl,
                providerTimestamp: context.now.toISOString(),
                recipients: context.defaultRecipients,
              },
              context.now
            )
            notificationsEnqueued += enqueued
          }
        }
      }
    }

    await applyAllOperationalNextPoll(
      tx,
      source,
      finalStates,
      outcome,
      context.now,
      "snapshot"
    )

    return {
      dependenciesEvaluated: installed.length,
      incidentsUpserted,
      notificationsEnqueued,
      flippedToUnknown: 0,
    }
  })
}

function errorCodeOf(error: Error): string {
  const withCode = error as { code?: string }
  return typeof withCode.code === "string" ? withCode.code : "UNKNOWN"
}

// -- Real Drizzle-backed store -------------------------------------------

export function createSqlPersistStore(db: Database): PersistStore {
  return {
    transaction: (work) =>
      db.transaction(async (tx) =>
        work({
          async loadInstalledDependencies(sourceId) {
            const rows = await tx
              .select({
                id: dependencies.id,
                catalogId: dependencies.catalogId,
                presetName: dependencyCatalog.displayName,
                scopeId: dependencies.scopeId,
                selector: dependencyCatalog.selector,
                fidelity: dependencyCatalog.fidelity,
                notificationsEnabled: dependencies.notificationsEnabled,
                currentState: dependencyState.state,
              })
              .from(dependencies)
              .innerJoin(
                dependencyCatalog,
                eq(dependencyCatalog.id, dependencies.catalogId)
              )
              .innerJoin(
                dependencyState,
                eq(dependencyState.dependencyId, dependencies.id)
              )
              .where(
                and(
                  eq(dependencyCatalog.sourceId, sourceId),
                  // A dependency on a drift-disabled preset stays whatever
                  // catalog-sync last set it to (UNKNOWN): excluding it here is
                  // what stops this poll from recomputing and overwriting that.
                  eq(dependencyCatalog.enabled, true),
                  isNull(dependencies.removedAt)
                )
              )
            return rows.map((row) => ({
              ...row,
              selector: row.selector as DependencySelector,
              fidelity: row.fidelity as DependencyFidelity,
              currentState: row.currentState as DependencyState,
            }))
          },

          async loadPriorIncidentResolution(sourceId, externalIds) {
            if (externalIds.length === 0) {
              return new Map()
            }
            const rows = await tx
              .select({
                externalId: providerIncidents.externalId,
                resolvedAt: providerIncidents.resolvedAt,
              })
              .from(providerIncidents)
              .where(
                and(
                  eq(providerIncidents.sourceId, sourceId),
                  inArray(providerIncidents.externalId, [...externalIds])
                )
              )
            return new Map(rows.map((row) => [row.externalId, row.resolvedAt]))
          },

          async loadExistingMatches(incidentIds) {
            if (incidentIds.length === 0) {
              return new Set()
            }
            const rows = await tx
              .select({
                dependencyId: dependencyIncidentMatches.dependencyId,
                incidentId: dependencyIncidentMatches.incidentId,
              })
              .from(dependencyIncidentMatches)
              .where(
                inArray(dependencyIncidentMatches.incidentId, [...incidentIds])
              )
            return new Set(
              rows.map((row) => `${row.dependencyId}:${row.incidentId}`)
            )
          },

          async loadOpenIncidents(sourceId) {
            const rows = await tx
              .select({
                internalId: providerIncidents.id,
                externalId: providerIncidents.externalId,
                title: providerIncidents.title,
                canonicalUrl: providerIncidents.canonicalUrl,
              })
              .from(providerIncidents)
              .where(
                and(
                  eq(providerIncidents.sourceId, sourceId),
                  isNull(providerIncidents.resolvedAt)
                )
              )
            return rows.map((row) => ({
              ...row,
              canonicalUrl: row.canonicalUrl ?? null,
            }))
          },

          async closeIncident(internalId, resolvedAt) {
            // greatest(resolvedAt, started_at) rather than a bare resolvedAt,
            // matching the interval-close guard: a stored-open incident whose
            // provider started_at is ahead of server now would otherwise land its
            // resolved_at before its own started_at and fail the
            // provider_incidents_resolution_order check, aborting the whole poll.
            // Bound as an ISO string, never a Date: raw sql params bypass
            // drizzle's column mappers and postgres-js rejects a Date at the
            // wire layer.
            const guardedResolvedAt = sql`greatest(${resolvedAt.toISOString()}, ${providerIncidents.startedAt})`
            await tx
              .update(providerIncidents)
              .set({
                state:
                  "resolved" as (typeof providerIncidents.$inferInsert)["state"],
                resolvedAt: guardedResolvedAt,
                providerUpdatedAt: guardedResolvedAt,
              })
              .where(eq(providerIncidents.id, internalId))
          },

          async upsertIncident(sourceId, candidateId, incident) {
            const values = {
              id: candidateId,
              sourceId,
              externalId: incident.externalId,
              title: incident.title,
              state:
                incident.state as (typeof providerIncidents.$inferInsert)["state"],
              impact: incident.impact,
              startedAt: new Date(incident.startedAt),
              resolvedAt: incident.resolvedAt
                ? new Date(incident.resolvedAt)
                : null,
              providerUpdatedAt: new Date(incident.updatedAt),
              canonicalUrl: incident.canonicalUrl,
            }
            // Always updates on conflict rather than gating on setWhere: a
            // WHERE-skipped conflict returns no row via RETURNING in Postgres,
            // which would otherwise make this fall back to the wrong (freshly
            // generated) id for an unchanged incident. provider_incidents is one
            // row per incident regardless, so the extra write on an unchanged
            // poll is cheap and never grows storage.
            const [row] = await tx
              .insert(providerIncidents)
              .values(values)
              .onConflictDoUpdate({
                target: [
                  providerIncidents.sourceId,
                  providerIncidents.externalId,
                ],
                set: {
                  title: values.title,
                  state: values.state,
                  impact: values.impact,
                  // Re-anchored on every upsert: on an unchanged poll this is the
                  // same provider-reported started time, a no-op, but when a
                  // provider reopens the same external id after resolve it carries
                  // the reopen's new started time, so overlap offsetSeconds and the
                  // detail "Started" track the current outage, not the first one.
                  startedAt: values.startedAt,
                  resolvedAt: values.resolvedAt,
                  providerUpdatedAt: values.providerUpdatedAt,
                  canonicalUrl: values.canonicalUrl,
                },
              })
              .returning({ id: providerIncidents.id })
            return row?.id ?? candidateId
          },

          async upsertIncidentComponents(
            incidentId,
            componentIds,
            associationKind
          ) {
            if (componentIds.length === 0) {
              return
            }
            await tx
              .insert(providerIncidentComponents)
              .values(
                componentIds.map((externalComponentId) => ({
                  incidentId,
                  externalComponentId,
                  associationKind,
                }))
              )
              .onConflictDoNothing()
          },

          async upsertIncidentUpdates(incidentId, updates) {
            if (updates.length === 0) {
              return
            }
            // Provider update rows are snapshots keyed by provider identity, not
            // append-only inserts. Advance state/body when the provider timestamp
            // is newer, accept same-timestamp material corrections, keep the
            // earliest created_at, and ignore older or identical snapshots.
            await tx
              .insert(providerIncidentUpdates)
              .values(
                updates.map((update) => ({
                  incidentId,
                  externalUpdateId: update.externalId,
                  state:
                    update.state as (typeof providerIncidentUpdates.$inferInsert)["state"],
                  bodyText: update.bodyText,
                  providerCreatedAt: new Date(update.createdAt),
                  providerUpdatedAt: new Date(update.updatedAt),
                }))
              )
              .onConflictDoUpdate({
                target: [
                  providerIncidentUpdates.incidentId,
                  providerIncidentUpdates.externalUpdateId,
                ],
                set: {
                  state: sql`excluded.state`,
                  bodyText: sql`excluded.body_text`,
                  providerUpdatedAt: sql`excluded.provider_updated_at`,
                  providerCreatedAt: sql`least(${providerIncidentUpdates.providerCreatedAt}, excluded.provider_created_at)`,
                },
                setWhere: sql`
              excluded.provider_updated_at > ${providerIncidentUpdates.providerUpdatedAt}
              OR (
                excluded.provider_updated_at = ${providerIncidentUpdates.providerUpdatedAt}
                AND (
                  excluded.state IS DISTINCT FROM ${providerIncidentUpdates.state}
                  OR excluded.body_text IS DISTINCT FROM ${providerIncidentUpdates.bodyText}
                )
              )
            `,
              })
          },

          async upsertDependencyIncidentMatch(
            dependencyId,
            incidentId,
            matchKind,
            now
          ) {
            const rows = await tx
              .insert(dependencyIncidentMatches)
              .values({ dependencyId, incidentId, matchKind, matchedAt: now })
              .onConflictDoNothing()
              .returning({
                dependencyId: dependencyIncidentMatches.dependencyId,
              })
            return rows.length > 0
          },

          async applyDependencyState(dependencyId, previousState, next, now) {
            await tx
              .update(dependencyState)
              .set({
                state: next.state,
                pendingFirstPoll: false,
                observedAt: next.observedAt,
                providerUpdatedAt: next.providerUpdatedAt,
                // Only a real snapshot advances the success timestamp. A
                // stale-failure flip to UNKNOWN leaves it untouched.
                ...(next.pollSucceeded ? { lastSuccessfulPollAt: now } : {}),
                ...(next.state === previousState
                  ? {}
                  : { stateStartedAt: now }),
              })
              .where(eq(dependencyState.dependencyId, dependencyId))

            if (next.state === previousState) {
              return
            }

            // greatest(now, started_at) rather than a bare `now`: under
            // cross-instance clock skew a slightly-behind now could otherwise
            // land before the interval's own started_at and fail the
            // ended_at >= started_at check, aborting the whole poll transaction.
            // Bound as an ISO string, never a Date: raw sql params bypass
            // drizzle's column mappers and postgres-js rejects a Date at the
            // wire layer.
            await tx
              .update(dependencyStateIntervals)
              .set({
                endedAt: sql`greatest(${now.toISOString()}, ${dependencyStateIntervals.startedAt})`,
              })
              .where(
                and(
                  eq(dependencyStateIntervals.dependencyId, dependencyId),
                  isNull(dependencyStateIntervals.endedAt)
                )
              )
            // F4: tolerate a lost close-then-insert race. This close-then-insert
            // is not atomic against the maintenance cron's flip, so a concurrent
            // transaction can close this interval between the update above (which
            // then matches zero rows) and this insert. Without the guard the
            // insert would then violate dependency_state_intervals_one_open and
            // abort the whole poll. Targeting that partial unique index with DO
            // NOTHING turns the lost race into a no-op: the interval the other
            // transaction opened stands, and this poll's other writes commit.
            await tx
              .insert(dependencyStateIntervals)
              .values({
                id: randomUUID(),
                dependencyId,
                state: next.state,
                startedAt: now,
                endedAt: null,
                sourceObservedAt: next.observedAt,
              })
              .onConflictDoNothing({
                // target plus this predicate name the partial unique index
                // dependency_state_intervals_one_open (dependency_id where ended_at
                // is null), so the conflict is caught rather than raised.
                target: dependencyStateIntervals.dependencyId,
                where: sql`${dependencyStateIntervals.endedAt} is null`,
              })
          },

          async enqueueNotification(input, now) {
            // Runs on the same tx handle as every other write in this
            // transaction, so the outbox row commits and rolls back with the
            // state, interval, and match writes rather than autocommitting on
            // a separate connection.
            return enqueueDependencyNotifications(
              tx,
              {
                event: input.event,
                sourceId: input.sourceId,
                incidentExternalId: input.incidentExternalId,
                presetId: input.presetId,
                scopeId: input.scopeId,
                dependencyId: input.dependencyId,
                dependencyName: input.dependencyName,
                provider: input.provider,
                incidentTitle: input.incidentTitle,
                state: input.state,
                canonicalUrl: input.canonicalUrl,
                providerTimestamp: input.providerTimestamp,
                recipients: input.recipients,
              },
              { now }
            )
          },

          async updateSourceHealthSuccess(sourceId, patch) {
            await tx
              .update(dependencySources)
              .set({
                etag: patch.etag,
                lastModified: patch.lastModified,
                lastAttemptAt: patch.now,
                lastSuccessAt: patch.now,
                consecutiveFailures: 0,
                lastErrorCode: null,
                nextPollAt: patch.nextPollAt,
              })
              .where(eq(dependencySources.id, sourceId))
          },

          async updateSourceHealthNotModified(sourceId, patch) {
            await tx
              .update(dependencySources)
              .set({
                lastAttemptAt: patch.now,
                lastSuccessAt: patch.now,
                consecutiveFailures: 0,
                lastErrorCode: null,
                nextPollAt: patch.nextPollAt,
              })
              .where(eq(dependencySources.id, sourceId))
          },

          async updateSourceHealthFailure(sourceId, patch) {
            await tx
              .update(dependencySources)
              .set({
                lastAttemptAt: patch.now,
                consecutiveFailures: patch.consecutiveFailures,
                lastErrorCode: patch.errorCode,
                nextPollAt: patch.nextPollAt,
              })
              .where(eq(dependencySources.id, sourceId))
          },
        })
      ),
  }
}
