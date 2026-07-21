import "server-only"

import { and, asc, desc, eq, gte, inArray, isNull, or } from "drizzle-orm"

import { type DatabaseHandle, db } from "@/lib/db/client"
import {
  dependencies,
  dependencyCatalog,
  dependencyCategories,
  dependencyDiscoveredScopeOptions,
  dependencyIncidentMatches,
  dependencySources,
  dependencyState,
  dependencyStateIntervals,
  providerIncidents,
  providerIncidentUpdates,
} from "@/lib/db/schema"

import type {
  DependencyFidelity,
  DependencyScope,
  DependencyState,
  ScopeSelection,
} from "./types"
import { resolveScopeSelection } from "./types"

// Reads for the Overview panel, the dependency detail view, and the add
// sheet's catalog listing. Kept db-direct (no injected store), matching
// lib/reporting/queries/* convention: reads are queried straight from the
// schema, mutations go through an injectable store in service.ts.

const STATE_PRIORITY: Record<DependencyState, number> = {
  OUTAGE: 0,
  DEGRADED: 1,
  MAINTENANCE: 2,
  UNKNOWN: 3,
  OPERATIONAL: 4,
}

interface IntervalRow {
  state: string
  startedAt: Date
  endedAt: Date | null
}

interface StateBucket {
  start: string
  state: DependencyState | null
}

/** Buckets a dependency's state-interval history into fixed-width windows, picking the worst overlapping state per bucket (or null when no interval covers it, i.e. before the dependency existed). */
function buildStateBuckets(
  intervals: readonly IntervalRow[],
  bucketCount: number,
  bucketMs: number,
  end: Date
): StateBucket[] {
  const windowStart = end.getTime() - bucketCount * bucketMs
  const buckets: StateBucket[] = []
  for (let index = 0; index < bucketCount; index += 1) {
    const bucketStart = windowStart + index * bucketMs
    const bucketEnd = bucketStart + bucketMs
    let worst: DependencyState | null = null
    for (const interval of intervals) {
      const intervalEnd = interval.endedAt
        ? interval.endedAt.getTime()
        : end.getTime()
      if (
        interval.startedAt.getTime() < bucketEnd &&
        intervalEnd > bucketStart
      ) {
        const state = interval.state as DependencyState
        if (worst === null || STATE_PRIORITY[state] < STATE_PRIORITY[worst]) {
          worst = state
        }
      }
    }
    buckets.push({ start: new Date(bucketStart).toISOString(), state: worst })
  }
  return buckets
}

// Resolves a dependency's stored scopeId to the human label operators pick at
// install time. required_options labels live inline in the catalog scope.
// discovered scopes carry their label in dependency_discovered_scope_options,
// passed in as discoveredLabel. Falls back to the raw scopeId when no label
// resolves, and returns null for an unscoped dependency.
function resolveScopeLabel(
  scope: DependencyScope | null,
  scopeId: string | null,
  discoveredLabel: string | null
): string | null {
  if (!scopeId) {
    return null
  }
  if (scope?.kind === "required_options") {
    return (
      scope.options.find((option) => option.id === scopeId)?.label ?? scopeId
    )
  }
  if (
    scope?.kind === "discovered_children" ||
    scope?.kind === "discovered_locations"
  ) {
    return discoveredLabel ?? scopeId
  }
  return scopeId
}

// Keys the batched discovered-scope label lookup. A catalogId and scopeId pair
// identifies one discovered option, joined by a NUL that cannot appear in
// either id.
function discoveredScopeKey(catalogId: string, scopeId: string): string {
  return `${catalogId}\x00${scopeId}`
}

export interface DependencyDashboardRow {
  id: string
  presetId: string
  scopeId: string | null
  componentLabel: string | null
  name: string
  provider: string
  category: string
  fidelity: DependencyFidelity
  state: DependencyState
  pendingFirstPoll: boolean
  providerUpdatedAt: string | null
  activeIncidentTitle: string | null
  timeline24h: StateBucket[]
}

export async function listDependenciesForDashboard(): Promise<
  DependencyDashboardRow[]
> {
  const rows = await db
    .select({
      id: dependencies.id,
      presetId: dependencies.catalogId,
      scopeId: dependencies.scopeId,
      scopeOptions: dependencyCatalog.scopeOptions,
      name: dependencyCatalog.displayName,
      category: dependencyCatalog.category,
      fidelity: dependencyCatalog.fidelity,
      provider: dependencySources.providerName,
      state: dependencyState.state,
      pendingFirstPoll: dependencyState.pendingFirstPoll,
      providerUpdatedAt: dependencyState.providerUpdatedAt,
    })
    .from(dependencies)
    .innerJoin(
      dependencyCatalog,
      eq(dependencyCatalog.id, dependencies.catalogId)
    )
    .innerJoin(
      dependencySources,
      eq(dependencySources.id, dependencyCatalog.sourceId)
    )
    .innerJoin(
      dependencyState,
      eq(dependencyState.dependencyId, dependencies.id)
    )
    .where(isNull(dependencies.removedAt))
    .orderBy(asc(dependencyCatalog.displayName))
  if (rows.length === 0) {
    return []
  }

  const ids = rows.map((row) => row.id)
  const now = new Date()
  const windowStart = new Date(now.getTime() - 24 * 3_600_000)

  // Catalog ids whose rows hold a discovered scope. Their labels live in
  // dependency_discovered_scope_options, batched into one lookup so the list
  // stays a fixed number of queries no matter the row count. required_options
  // scopes resolve inline from the catalog scope and need no lookup.
  const discoveredCatalogIds = Array.from(
    new Set(
      rows
        .filter((row) => {
          const scope = (row.scopeOptions as DependencyScope | null) ?? null
          return (
            row.scopeId !== null &&
            (scope?.kind === "discovered_children" ||
              scope?.kind === "discovered_locations")
          )
        })
        .map((row) => row.presetId)
    )
  )

  const [intervalRows, incidentRows, discoveredRows] = await Promise.all([
    db
      .select({
        dependencyId: dependencyStateIntervals.dependencyId,
        state: dependencyStateIntervals.state,
        startedAt: dependencyStateIntervals.startedAt,
        endedAt: dependencyStateIntervals.endedAt,
      })
      .from(dependencyStateIntervals)
      .where(
        and(
          inArray(dependencyStateIntervals.dependencyId, ids),
          or(
            isNull(dependencyStateIntervals.endedAt),
            gte(dependencyStateIntervals.endedAt, windowStart)
          )
        )
      ),
    db
      .select({
        dependencyId: dependencyIncidentMatches.dependencyId,
        title: providerIncidents.title,
        providerUpdatedAt: providerIncidents.providerUpdatedAt,
      })
      .from(dependencyIncidentMatches)
      .innerJoin(
        providerIncidents,
        eq(providerIncidents.id, dependencyIncidentMatches.incidentId)
      )
      .where(
        and(
          inArray(dependencyIncidentMatches.dependencyId, ids),
          isNull(providerIncidents.resolvedAt)
        )
      ),
    discoveredCatalogIds.length === 0
      ? Promise.resolve(
          [] as { catalogId: string; scopeId: string; label: string }[]
        )
      : db
          .select({
            catalogId: dependencyDiscoveredScopeOptions.catalogId,
            scopeId: dependencyDiscoveredScopeOptions.scopeId,
            label: dependencyDiscoveredScopeOptions.label,
          })
          .from(dependencyDiscoveredScopeOptions)
          .where(
            inArray(
              dependencyDiscoveredScopeOptions.catalogId,
              discoveredCatalogIds
            )
          ),
  ])

  const discoveredLabelByKey = new Map<string, string>()
  for (const row of discoveredRows) {
    discoveredLabelByKey.set(
      discoveredScopeKey(row.catalogId, row.scopeId),
      row.label
    )
  }

  const intervalsByDependency = new Map<string, IntervalRow[]>()
  for (const row of intervalRows) {
    const list = intervalsByDependency.get(row.dependencyId) ?? []
    list.push(row)
    intervalsByDependency.set(row.dependencyId, list)
  }
  const activeIncidentByDependency = new Map<
    string,
    { title: string; providerUpdatedAt: Date }
  >()
  for (const row of incidentRows) {
    const existing = activeIncidentByDependency.get(row.dependencyId)
    if (!existing || row.providerUpdatedAt > existing.providerUpdatedAt) {
      activeIncidentByDependency.set(row.dependencyId, {
        title: row.title,
        providerUpdatedAt: row.providerUpdatedAt,
      })
    }
  }

  return rows.map((row) => {
    const active = activeIncidentByDependency.get(row.id)
    const scope = (row.scopeOptions as DependencyScope | null) ?? null
    const discoveredLabel =
      row.scopeId === null
        ? null
        : (discoveredLabelByKey.get(
            discoveredScopeKey(row.presetId, row.scopeId)
          ) ?? null)
    return {
      id: row.id,
      presetId: row.presetId,
      scopeId: row.scopeId,
      componentLabel: resolveScopeLabel(scope, row.scopeId, discoveredLabel),
      name: row.name,
      provider: row.provider,
      category: row.category,
      fidelity: row.fidelity as DependencyFidelity,
      state: row.state as DependencyState,
      pendingFirstPoll: row.pendingFirstPoll,
      providerUpdatedAt:
        (active?.providerUpdatedAt ?? row.providerUpdatedAt)?.toISOString() ??
        null,
      activeIncidentTitle: active?.title ?? null,
      timeline24h: buildStateBuckets(
        intervalsByDependency.get(row.id) ?? [],
        24,
        3_600_000,
        now
      ),
    }
  })
}

interface DependencyIncidentUpdate {
  state: string
  bodyText: string
  createdAt: string
  updatedAt: string
}

interface DependencyIncident {
  id: string
  title: string
  state: string
  impact: string | null
  startedAt: string
  resolvedAt: string | null
  providerUpdatedAt: string
  canonicalUrl: string | null
  updates: DependencyIncidentUpdate[]
}

export interface DependencyDetail {
  id: string
  presetId: string
  scopeId: string | null
  name: string
  description: string
  category: string
  provider: string
  fidelity: DependencyFidelity
  componentLabel: string | null
  sourceScopeNote: string | null
  notificationsEnabled: boolean
  createdAt: string
  state: DependencyState
  pendingFirstPoll: boolean
  stateStartedAt: string
  providerUpdatedAt: string | null
  observedAt: string
  lastSuccessfulPollAt: string | null
  canonicalUrl: string
  incidents: DependencyIncident[]
  timeline24h: StateBucket[]
  timeline7d: StateBucket[]
}

// Accepts a handle so a caller inside a transaction (addDependency) can read
// its own uncommitted insert back on the same connection, instead of a pooled
// connection that would not see it yet under READ COMMITTED.
export async function getDependencyDetail(
  id: string,
  handle: DatabaseHandle = db
): Promise<DependencyDetail | null> {
  const [row] = await handle
    .select({
      id: dependencies.id,
      presetId: dependencies.catalogId,
      scopeId: dependencies.scopeId,
      notificationsEnabled: dependencies.notificationsEnabled,
      createdAt: dependencies.createdAt,
      name: dependencyCatalog.displayName,
      description: dependencyCatalog.description,
      category: dependencyCatalog.category,
      scopeOptions: dependencyCatalog.scopeOptions,
      sourceScopeNote: dependencyCatalog.sourceScopeNote,
      fidelity: dependencyCatalog.fidelity,
      provider: dependencySources.providerName,
      statusPageUrl: dependencySources.statusPageUrl,
      state: dependencyState.state,
      pendingFirstPoll: dependencyState.pendingFirstPoll,
      stateStartedAt: dependencyState.stateStartedAt,
      providerUpdatedAt: dependencyState.providerUpdatedAt,
      observedAt: dependencyState.observedAt,
      lastSuccessfulPollAt: dependencyState.lastSuccessfulPollAt,
    })
    .from(dependencies)
    .innerJoin(
      dependencyCatalog,
      eq(dependencyCatalog.id, dependencies.catalogId)
    )
    .innerJoin(
      dependencySources,
      eq(dependencySources.id, dependencyCatalog.sourceId)
    )
    .innerJoin(
      dependencyState,
      eq(dependencyState.dependencyId, dependencies.id)
    )
    .where(and(eq(dependencies.id, id), isNull(dependencies.removedAt)))
    .limit(1)
  if (!row) {
    return null
  }

  const now = new Date()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000)
  const [intervals, incidentRows] = await Promise.all([
    handle
      .select({
        state: dependencyStateIntervals.state,
        startedAt: dependencyStateIntervals.startedAt,
        endedAt: dependencyStateIntervals.endedAt,
      })
      .from(dependencyStateIntervals)
      .where(
        and(
          eq(dependencyStateIntervals.dependencyId, id),
          or(
            isNull(dependencyStateIntervals.endedAt),
            gte(dependencyStateIntervals.endedAt, sevenDaysAgo)
          )
        )
      )
      .orderBy(asc(dependencyStateIntervals.startedAt)),
    handle
      .select({
        id: providerIncidents.id,
        title: providerIncidents.title,
        state: providerIncidents.state,
        impact: providerIncidents.impact,
        startedAt: providerIncidents.startedAt,
        resolvedAt: providerIncidents.resolvedAt,
        providerUpdatedAt: providerIncidents.providerUpdatedAt,
        canonicalUrl: providerIncidents.canonicalUrl,
      })
      .from(dependencyIncidentMatches)
      .innerJoin(
        providerIncidents,
        eq(providerIncidents.id, dependencyIncidentMatches.incidentId)
      )
      .where(eq(dependencyIncidentMatches.dependencyId, id))
      .orderBy(desc(providerIncidents.startedAt))
      .limit(20),
  ])

  const updateRows =
    incidentRows.length === 0
      ? []
      : await handle
          .select({
            incidentId: providerIncidentUpdates.incidentId,
            state: providerIncidentUpdates.state,
            bodyText: providerIncidentUpdates.bodyText,
            providerCreatedAt: providerIncidentUpdates.providerCreatedAt,
            providerUpdatedAt: providerIncidentUpdates.providerUpdatedAt,
          })
          .from(providerIncidentUpdates)
          .where(
            inArray(
              providerIncidentUpdates.incidentId,
              incidentRows.map((incident) => incident.id)
            )
          )
          .orderBy(asc(providerIncidentUpdates.providerCreatedAt))

  const updatesByIncident = new Map<string, typeof updateRows>()
  for (const update of updateRows) {
    const list = updatesByIncident.get(update.incidentId) ?? []
    list.push(update)
    updatesByIncident.set(update.incidentId, list)
  }

  const scope = (row.scopeOptions as DependencyScope | null) ?? null
  let discoveredLabel: string | null = null
  if (
    row.scopeId &&
    (scope?.kind === "discovered_children" ||
      scope?.kind === "discovered_locations")
  ) {
    const [discovered] = await handle
      .select({
        label: dependencyDiscoveredScopeOptions.label,
      })
      .from(dependencyDiscoveredScopeOptions)
      .where(
        and(
          eq(dependencyDiscoveredScopeOptions.catalogId, row.presetId),
          eq(dependencyDiscoveredScopeOptions.scopeId, row.scopeId)
        )
      )
      .limit(1)
    discoveredLabel = discovered?.label ?? null
  }
  const componentLabel = resolveScopeLabel(scope, row.scopeId, discoveredLabel)

  const activeIncident =
    incidentRows.find((incident) => incident.resolvedAt === null) ?? null

  return {
    id: row.id,
    presetId: row.presetId,
    scopeId: row.scopeId,
    name: row.name,
    description: row.description,
    category: row.category,
    provider: row.provider,
    fidelity: row.fidelity as DependencyFidelity,
    componentLabel: componentLabel ?? null,
    sourceScopeNote: row.sourceScopeNote,
    notificationsEnabled: row.notificationsEnabled,
    createdAt: row.createdAt.toISOString(),
    state: row.state as DependencyState,
    pendingFirstPoll: row.pendingFirstPoll,
    stateStartedAt: row.stateStartedAt.toISOString(),
    providerUpdatedAt: row.providerUpdatedAt?.toISOString() ?? null,
    observedAt: row.observedAt.toISOString(),
    lastSuccessfulPollAt: row.lastSuccessfulPollAt?.toISOString() ?? null,
    canonicalUrl: activeIncident?.canonicalUrl ?? row.statusPageUrl,
    incidents: incidentRows.map((incident) => ({
      id: incident.id,
      title: incident.title,
      state: incident.state,
      impact: incident.impact,
      startedAt: incident.startedAt.toISOString(),
      resolvedAt: incident.resolvedAt?.toISOString() ?? null,
      providerUpdatedAt: incident.providerUpdatedAt.toISOString(),
      canonicalUrl: incident.canonicalUrl,
      updates: (updatesByIncident.get(incident.id) ?? []).map((update) => ({
        state: update.state,
        bodyText: update.bodyText,
        createdAt: update.providerCreatedAt.toISOString(),
        updatedAt: update.providerUpdatedAt.toISOString(),
      })),
    })),
    timeline24h: buildStateBuckets(intervals, 24, 3_600_000, now),
    timeline7d: buildStateBuckets(intervals, 7, 86_400_000, now),
  }
}

export interface DependencyCatalogPreset {
  id: string
  name: string
  provider: string
  description: string
  /**
   * Resolved selection model for install UI. Manifest-level scope unions stay
   * internal; clients consume scopeSelection only.
   */
  scopeSelection: ScopeSelection | null
  sourceScopeNote: string | null
  fidelity: DependencyFidelity
  enabled: boolean
  validated: boolean
  // Mirrors the server install gate. addDependency rejects a preset with a
  // recorded validationError, so the add sheet disables Add for the same set.
  // Distinct from validated, which is merely whether a successful validation
  // has ever run. A never-validated preset is installable.
  hasValidationError: boolean
  installed: boolean
  installedScopeIds: string[]
}

export interface DependencyCatalogCategory {
  category: string
  presets: DependencyCatalogPreset[]
}

export async function listCatalog(): Promise<DependencyCatalogCategory[]> {
  const presetRows = await db
    .select({
      id: dependencyCatalog.id,
      name: dependencyCatalog.displayName,
      category: dependencyCatalog.category,
      description: dependencyCatalog.description,
      scope: dependencyCatalog.scopeOptions,
      sourceScopeNote: dependencyCatalog.sourceScopeNote,
      fidelity: dependencyCatalog.fidelity,
      enabled: dependencyCatalog.enabled,
      validatedAt: dependencyCatalog.validatedAt,
      validationError: dependencyCatalog.validationError,
      provider: dependencySources.providerName,
    })
    .from(dependencyCatalog)
    .innerJoin(
      dependencySources,
      eq(dependencySources.id, dependencyCatalog.sourceId)
    )
    .orderBy(
      asc(dependencyCatalog.category),
      asc(dependencyCatalog.displayName)
    )

  const [installedRows, discoveredRows] = await Promise.all([
    db
      .select({
        catalogId: dependencies.catalogId,
        scopeId: dependencies.scopeId,
      })
      .from(dependencies)
      .where(isNull(dependencies.removedAt)),
    db
      .select({
        catalogId: dependencyDiscoveredScopeOptions.catalogId,
        scopeId: dependencyDiscoveredScopeOptions.scopeId,
        label: dependencyDiscoveredScopeOptions.label,
        available: dependencyDiscoveredScopeOptions.available,
      })
      .from(dependencyDiscoveredScopeOptions)
      .orderBy(asc(dependencyDiscoveredScopeOptions.label)),
  ])

  const NO_SCOPE = ""
  const installedScopesByCatalog = new Map<string, string[]>()
  for (const row of installedRows) {
    const list = installedScopesByCatalog.get(row.catalogId) ?? []
    list.push(row.scopeId ?? NO_SCOPE)
    installedScopesByCatalog.set(row.catalogId, list)
  }

  const discoveredByCatalog = new Map<
    string,
    Array<{ id: string; label: string; available: boolean }>
  >()
  for (const row of discoveredRows) {
    const list = discoveredByCatalog.get(row.catalogId) ?? []
    list.push({ id: row.scopeId, label: row.label, available: row.available })
    discoveredByCatalog.set(row.catalogId, list)
  }

  const grouped = new Map<string, DependencyCatalogPreset[]>()
  for (const preset of presetRows) {
    const installedScopes = installedScopesByCatalog.get(preset.id) ?? []
    const scope = (preset.scope as DependencyScope | null) ?? null
    const list = grouped.get(preset.category) ?? []
    list.push({
      id: preset.id,
      name: preset.name,
      provider: preset.provider,
      description: preset.description,
      scopeSelection: resolveScopeSelection(
        scope,
        discoveredByCatalog.get(preset.id) ?? null
      ),
      sourceScopeNote: preset.sourceScopeNote,
      fidelity: preset.fidelity as DependencyFidelity,
      enabled: preset.enabled,
      validated: preset.validatedAt !== null,
      hasValidationError: preset.validationError !== null,
      installed: installedScopes.includes(NO_SCOPE),
      installedScopeIds: installedScopes.filter(
        (scopeId) => scopeId !== NO_SCOPE
      ),
    })
    grouped.set(preset.category, list)
  }

  return dependencyCategories
    .filter((category) => grouped.has(category))
    .map((category) => ({ category, presets: grouped.get(category)! }))
}
