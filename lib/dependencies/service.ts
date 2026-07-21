import "server-only"

import { randomUUID } from "node:crypto"

import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm"
import { z } from "zod"

import { type DatabaseHandle, db } from "@/lib/db/client"
import {
  dependencies,
  dependencyCatalog,
  dependencyDiscoveredScopeOptions,
  dependencySources,
  dependencyState,
  dependencyStateIntervals,
} from "@/lib/db/schema"

import { backfillResolvedIncidentMatches } from "./persist"
import {
  listDependenciesForDashboard,
  getDependencyDetail as queryDependencyDetail,
  listCatalog as queryListCatalog,
} from "./queries"
import type { DependencyScope, DependencyState } from "./types"

// Install semantics per Docs/Specs/DEPENDENCY-MONITORING.md "One-click installation
// path": no provider credentials, one transaction, and a fresh-snapshot rule
// so a brand-new install never has to lie about its state.

const FRESHNESS_WINDOW_MS = 10 * 60_000

export class DependencyApiError extends Error {
  constructor(
    readonly code:
      | "PRESET_NOT_FOUND"
      | "PRESET_UNAVAILABLE"
      | "SCOPE_REQUIRED"
      | "INVALID_SCOPE"
      | "SCOPE_OPTIONS_UNAVAILABLE"
      | "SCOPE_NO_LONGER_AVAILABLE"
      | "DEPENDENCY_EXISTS"
      | "DEPENDENCY_NOT_FOUND",
    message: string,
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "DependencyApiError"
  }
}

interface DiscoveredScopeOptionRow {
  scopeId: string
  label: string
  available: boolean
}

/**
 * Thrown instead of returning false when a unique-violation lands on a
 * transaction handle the caller supplied rather than one this store opened
 * itself. Postgres aborts that whole transaction the moment the violation
 * hits, so there is no live handle left to write a stored outcome into, and
 * the caller must propagate this untouched rather than attempt another
 * statement on it.
 */
export class DependencyInstallConflictError extends DependencyApiError {
  constructor(
    message: string,
    details: Record<string, unknown> = {},
    options?: ErrorOptions
  ) {
    super("DEPENDENCY_EXISTS", message, details, options)
    this.name = "DependencyInstallConflictError"
  }
}

export interface DependencyPresetRow {
  id: string
  sourceId: string
  enabled: boolean
  validatedAt: Date | null
  validationError: string | null
  scope: DependencyScope | null
}

interface DependencyRow {
  id: string
  catalogId: string
  scopeId: string | null
  notificationsEnabled: boolean
  createdAt: Date
  removedAt: Date | null
}

export interface DependencyStateSnapshot {
  state: DependencyState
  pendingFirstPoll: boolean
  observedAt: Date
  providerUpdatedAt: Date | null
}

export interface DependenciesStore {
  loadPreset: (presetId: string) => Promise<DependencyPresetRow | null>
  /**
   * Discovered scope options for a preset, including unavailable ones kept
   * after a complete directory refresh. Empty when discovery has not yet
   * materialised any row for this catalog id.
   */
  loadDiscoveredScopeOptions: (
    catalogId: string
  ) => Promise<DiscoveredScopeOptionRow[]>
  /**
   * Seeds a fresh install from the most recent observation of the SAME
   * (catalogId, scopeId) pair, when one is fresh. Only a previously removed
   * dependency can share that pair with a brand-new install, since an active
   * duplicate is rejected before this ever gets a chance to matter. This
   * lets a quick reinstall reuse the provider's last known state instead of
   * a needless UNKNOWN bounce, while a stale or first-ever install still
   * falls through to UNKNOWN with pendingFirstPoll set.
   */
  loadRecentStateForCatalogScope: (
    catalogId: string,
    scopeId: string | null,
    freshAfter: Date
  ) => Promise<DependencyStateSnapshot | null>
  /**
   * Inserts the dependency, its opening state, and its opening interval, and
   * schedules the source for immediate polling. With no handle given, this
   * runs in its own transaction and a duplicate on the partial unique index
   * on (catalogId, scopeId) among active dependencies resolves as false.
   * With a caller-supplied handle, the insert runs directly on it, and since
   * a duplicate there aborts that whole transaction rather than just the
   * statement, it throws DependencyInstallConflictError instead, since the
   * caller has no live handle left to act on a plain false with.
   */
  insertDependency: (input: {
    dependency: DependencyRow
    state: DependencyStateSnapshot
    intervalId: string
    sourceId: string
    now: Date
    handle?: DatabaseHandle
  }) => Promise<boolean>
  touchSourceNextPoll: (
    sourceId: string,
    now: Date,
    handle?: DatabaseHandle
  ) => Promise<void>
  loadSourceIdForDependency: (id: string) => Promise<string | null>
  /**
   * Soft removal: sets removedAt and closes the open interval. With no handle
   * given this runs in its own transaction; with a caller-supplied handle
   * (the idempotency path) the writes run directly on it so the removal and
   * the idempotency record commit together, mirroring insertDependency.
   * Returns false when no active dependency matches.
   */
  removeDependency: (
    id: string,
    now: Date,
    handle?: DatabaseHandle
  ) => Promise<boolean>
  patchNotifications: (
    id: string,
    notificationsEnabled: boolean,
    handle?: DatabaseHandle
  ) => Promise<boolean>
}

export interface DependencyServiceDeps {
  store?: DependenciesStore
  now?: () => Date
  newId?: () => string
  /** Pins the installed dependency's own id to the idempotency operationId, mirroring status-reports' reportId pinning, so a crash-recovery retry finds the same row instead of inserting a second one. */
  dependencyId?: string
}

export interface AddDependencyInput {
  presetId: string
  scopeId?: string | null
  notificationsEnabled?: boolean
}

/**
 * Validates the requested scopeId against the preset's scope contract.
 * `required_options` ships a static validated list in the catalog, so it is
 * checked exactly. `discovered_children` and `discovered_locations` resolve
 * against materialised dependency_discovered_scope_options rows: arbitrary
 * ids are rejected, unavailable options surface SCOPE_NO_LONGER_AVAILABLE,
 * and an empty option set surfaces SCOPE_OPTIONS_UNAVAILABLE.
 */
async function validateScope(
  store: DependenciesStore,
  catalogId: string,
  scope: DependencyScope | null,
  scopeId: string | null | undefined
): Promise<string | null> {
  if (!scope) {
    if (scopeId) {
      throw new DependencyApiError(
        "INVALID_SCOPE",
        "This preset does not accept a scope"
      )
    }
    return null
  }
  if (scope.kind === "required_options") {
    if (!scopeId) {
      throw new DependencyApiError(
        "SCOPE_REQUIRED",
        "This preset requires a scopeId"
      )
    }
    if (!scope.options.some((option) => option.id === scopeId)) {
      throw new DependencyApiError(
        "INVALID_SCOPE",
        "scopeId is not one of the preset's validated options"
      )
    }
    return scopeId
  }

  // discovered_children | discovered_locations
  if (scope.required && !scopeId) {
    throw new DependencyApiError(
      "SCOPE_REQUIRED",
      "This preset requires a scopeId"
    )
  }
  if (!scopeId) {
    return null
  }

  const options = await store.loadDiscoveredScopeOptions(catalogId)
  if (options.length === 0) {
    throw new DependencyApiError(
      "SCOPE_OPTIONS_UNAVAILABLE",
      "Scope options have not been discovered yet for this preset"
    )
  }
  const match = options.find((option) => option.scopeId === scopeId)
  if (!match) {
    throw new DependencyApiError(
      "INVALID_SCOPE",
      "scopeId is not one of the preset's discovered options"
    )
  }
  if (!match.available) {
    throw new DependencyApiError(
      "SCOPE_NO_LONGER_AVAILABLE",
      "The selected scope is no longer available from the provider"
    )
  }
  return scopeId
}

export async function addDependency(
  input: AddDependencyInput,
  deps: DependencyServiceDeps = {},
  handle: DatabaseHandle = db
) {
  const store = deps.store ?? databaseDependenciesStore
  const now = deps.now?.() ?? new Date()
  const newId = deps.newId ?? (() => randomUUID())

  const preset = await store.loadPreset(input.presetId)
  if (!preset) {
    throw new DependencyApiError("PRESET_NOT_FOUND", "Preset was not found")
  }
  // Catalog validation is drift detection against a preset already shipped in
  // the curated bundled catalog, not pre-clearance for installing it. A
  // never-validated preset (validatedAt and validationError both null) is
  // installable. Only a disabled preset or one with a recorded validation
  // error is blocked.
  if (!preset.enabled || preset.validationError) {
    throw new DependencyApiError(
      "PRESET_UNAVAILABLE",
      "Preset is disabled or catalog validation found it no longer matches its upstream feed"
    )
  }
  const scopeId = await validateScope(
    store,
    preset.id,
    preset.scope,
    input.scopeId
  )

  const freshAfter = new Date(now.getTime() - FRESHNESS_WINDOW_MS)
  const recent = await store.loadRecentStateForCatalogScope(
    preset.id,
    scopeId,
    freshAfter
  )
  const state: DependencyStateSnapshot = recent ?? {
    state: "UNKNOWN",
    pendingFirstPoll: true,
    observedAt: now,
    providerUpdatedAt: null,
  }

  const dependency: DependencyRow = {
    id: deps.dependencyId ?? newId(),
    catalogId: preset.id,
    scopeId,
    notificationsEnabled: input.notificationsEnabled ?? true,
    createdAt: now,
    removedAt: null,
  }

  const inserted = await store.insertDependency({
    dependency,
    state,
    intervalId: newId(),
    sourceId: preset.sourceId,
    now,
    handle,
  })
  if (!inserted) {
    throw new DependencyApiError(
      "DEPENDENCY_EXISTS",
      "An active dependency already exists for this preset and scope"
    )
  }

  // Reads back on the same handle as the insert above, so an install running
  // inside a caller's transaction sees its own uncommitted row instead of a
  // second pooled connection that has not yet observed it.
  const detail = await queryDependencyDetail(dependency.id, handle)
  if (!detail) {
    throw new Error("Dependency vanished immediately after insert")
  }
  return detail
}

export async function listDependencies() {
  return listDependenciesForDashboard()
}

export async function requireDependencyDetail(id: string) {
  const detail = await queryDependencyDetail(id)
  if (!detail) {
    throw new DependencyApiError(
      "DEPENDENCY_NOT_FOUND",
      "Dependency was not found"
    )
  }
  return detail
}

export async function listCatalog() {
  return queryListCatalog()
}

const patchSchema = z.object({ notificationsEnabled: z.boolean() }).strict()

export async function patchDependency(
  id: string,
  input: unknown,
  deps: DependencyServiceDeps = {},
  handle: DatabaseHandle = db
) {
  const store = deps.store ?? databaseDependenciesStore
  const parsed = patchSchema.parse(input)
  const patched = await store.patchNotifications(
    id,
    parsed.notificationsEnabled,
    handle
  )
  if (!patched) {
    throw new DependencyApiError(
      "DEPENDENCY_NOT_FOUND",
      "Dependency was not found"
    )
  }
  // Reads back on the same handle as the update above, so a patch running
  // inside a caller's transaction sees its own uncommitted row rather than a
  // second pooled connection that has not observed it, mirroring
  // addDependency's read-back.
  const detail = await queryDependencyDetail(id, handle)
  if (!detail) {
    throw new DependencyApiError(
      "DEPENDENCY_NOT_FOUND",
      "Dependency was not found"
    )
  }
  return detail
}

export async function removeDependency(
  id: string,
  deps: DependencyServiceDeps = {},
  handle: DatabaseHandle = db
) {
  const store = deps.store ?? databaseDependenciesStore
  const now = deps.now?.() ?? new Date()
  const removed = await store.removeDependency(id, now, handle)
  if (!removed) {
    throw new DependencyApiError(
      "DEPENDENCY_NOT_FOUND",
      "Dependency was not found"
    )
  }
  return { id, removed: true }
}

/** Sets the source's next_poll_at to now and returns immediately; the cron picks up the fetch, so this route never touches the network. */
export async function scheduleDependencyPoll(
  id: string,
  deps: DependencyServiceDeps = {},
  handle: DatabaseHandle = db
) {
  const store = deps.store ?? databaseDependenciesStore
  const now = deps.now?.() ?? new Date()
  const sourceId = await store.loadSourceIdForDependency(id)
  if (!sourceId) {
    throw new DependencyApiError(
      "DEPENDENCY_NOT_FOUND",
      "Dependency was not found"
    )
  }
  // When a handle is supplied (idempotent refresh route), next_poll_at and
  // the idempotency completion commit on the same transaction.
  await store.touchSourceNextPoll(sourceId, now, handle)
  return { id, queued: true }
}

export const databaseDependenciesStore: DependenciesStore = {
  async loadPreset(presetId) {
    const [row] = await db
      .select({
        id: dependencyCatalog.id,
        sourceId: dependencyCatalog.sourceId,
        enabled: dependencyCatalog.enabled,
        validatedAt: dependencyCatalog.validatedAt,
        validationError: dependencyCatalog.validationError,
        scope: dependencyCatalog.scopeOptions,
      })
      .from(dependencyCatalog)
      .where(eq(dependencyCatalog.id, presetId))
      .limit(1)
    return row
      ? { ...row, scope: (row.scope as DependencyScope | null) ?? null }
      : null
  },

  async loadDiscoveredScopeOptions(catalogId) {
    return db
      .select({
        scopeId: dependencyDiscoveredScopeOptions.scopeId,
        label: dependencyDiscoveredScopeOptions.label,
        available: dependencyDiscoveredScopeOptions.available,
      })
      .from(dependencyDiscoveredScopeOptions)
      .where(eq(dependencyDiscoveredScopeOptions.catalogId, catalogId))
      .orderBy(asc(dependencyDiscoveredScopeOptions.label))
  },

  async loadRecentStateForCatalogScope(catalogId, scopeId, freshAfter) {
    const [row] = await db
      .select({
        state: dependencyState.state,
        pendingFirstPoll: dependencyState.pendingFirstPoll,
        observedAt: dependencyState.observedAt,
        providerUpdatedAt: dependencyState.providerUpdatedAt,
      })
      .from(dependencyState)
      .innerJoin(
        dependencies,
        eq(dependencies.id, dependencyState.dependencyId)
      )
      .where(
        and(
          eq(dependencies.catalogId, catalogId),
          scopeId === null
            ? isNull(dependencies.scopeId)
            : eq(dependencies.scopeId, scopeId),
          gte(dependencyState.observedAt, freshAfter)
        )
      )
      .orderBy(desc(dependencyState.observedAt))
      .limit(1)
    return row ? { ...row, state: row.state as DependencyState } : null
  },

  async insertDependency({
    dependency,
    state,
    intervalId,
    sourceId,
    now,
    handle,
  }) {
    // Runs the writes on the caller's transaction when one is supplied (the
    // idempotency path) so the dependency and its idempotency record commit
    // atomically, or opens its own transaction otherwise. Either way the
    // duplicate check is a pre-check SELECT inside the same handle first,
    // with the partial unique index as the last-resort backstop for the
    // race a pre-check cannot close.
    const runInsert = async (tx: DatabaseHandle): Promise<boolean> => {
      const [existing] = await tx
        .select({ id: dependencies.id })
        .from(dependencies)
        .where(
          and(
            eq(dependencies.catalogId, dependency.catalogId),
            dependency.scopeId === null
              ? isNull(dependencies.scopeId)
              : eq(dependencies.scopeId, dependency.scopeId),
            isNull(dependencies.removedAt)
          )
        )
        .limit(1)
      if (existing) {
        return false
      }
      await tx.insert(dependencies).values(dependency)
      await tx.insert(dependencyState).values({
        dependencyId: dependency.id,
        state: state.state,
        pendingFirstPoll: state.pendingFirstPoll,
        stateStartedAt: now,
        providerUpdatedAt: state.providerUpdatedAt,
        observedAt: state.observedAt,
        lastSuccessfulPollAt: null,
      })
      await tx.insert(dependencyStateIntervals).values({
        id: intervalId,
        dependencyId: dependency.id,
        state: state.state,
        startedAt: now,
        endedAt: null,
        sourceObservedAt: state.observedAt,
      })
      // Link the source's recent resolved incidents so this install's timeline
      // and incident list carry real history immediately. Runs on the same tx
      // as the insert so the matches commit atomically with the dependency;
      // the poll path never prunes matches, so the immediate first poll leaves
      // them intact.
      await backfillResolvedIncidentMatches(tx, {
        dependencyId: dependency.id,
        catalogId: dependency.catalogId,
        sourceId,
        scopeId: dependency.scopeId,
        now,
      })
      // Clearing etag/lastModified alongside next_poll_at forces the next
      // poll to a 200 with a full body: a stale validator would otherwise
      // let the provider answer 304, leaving this freshly installed
      // dependency stuck UNKNOWN with pendingFirstPoll set and nothing to
      // adopt state from.
      await tx
        .update(dependencySources)
        .set({ nextPollAt: now, etag: null, lastModified: null })
        .where(eq(dependencySources.id, sourceId))
      return true
    }
    // A handle equal to this module's own db is the unset default, so this
    // store owns the transaction boundary and maps a unique violation to a
    // plain false. A handle that differs is the caller's own, already-open
    // transaction (the idempotency path), where a unique violation aborts
    // the whole transaction, so it surfaces as a typed error instead of a
    // return value with no live handle left to act on it.
    if (handle && handle !== db) {
      try {
        return await runInsert(handle)
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          // biome-ignore lint/style/useErrorCause: cause is threaded through the error options arg, biome only detects the native second-argument position
          throw new DependencyInstallConflictError(
            "An active dependency already exists for this preset and scope",
            {},
            { cause: error }
          )
        }
        throw error
      }
    }
    try {
      return await db.transaction(runInsert)
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        return false
      }
      throw error
    }
  },

  async touchSourceNextPoll(sourceId, now, handle) {
    // Same validator clearing as insertDependency: a manual refresh must
    // force a 200, not risk a 304 that leaves the dependency's state stale.
    await (handle ?? db)
      .update(dependencySources)
      .set({ nextPollAt: now, etag: null, lastModified: null })
      .where(eq(dependencySources.id, sourceId))
  },

  async loadSourceIdForDependency(id) {
    const [row] = await db
      .select({ sourceId: dependencyCatalog.sourceId })
      .from(dependencies)
      .innerJoin(
        dependencyCatalog,
        eq(dependencyCatalog.id, dependencies.catalogId)
      )
      .where(and(eq(dependencies.id, id), isNull(dependencies.removedAt)))
      .limit(1)
    return row?.sourceId ?? null
  },

  async removeDependency(id, now, handle) {
    const run = async (tx: DatabaseHandle): Promise<boolean> => {
      const updated = await tx
        .update(dependencies)
        .set({ removedAt: now })
        .where(and(eq(dependencies.id, id), isNull(dependencies.removedAt)))
        .returning({ id: dependencies.id })
      if (!updated[0]) {
        return false
      }
      // greatest(now, started_at) mirrors the poll path (see persist.ts): a
      // slightly-behind now under cross-instance clock skew must not land
      // before the interval's own started_at and fail the
      // ended_at >= started_at check, which would abort this transaction.
      // Bound as an ISO string, never a Date: raw sql params bypass drizzle's
      // column mappers and postgres-js rejects a Date at the wire layer.
      await tx
        .update(dependencyStateIntervals)
        .set({
          endedAt: sql`greatest(${now.toISOString()}, ${dependencyStateIntervals.startedAt})`,
        })
        .where(
          and(
            eq(dependencyStateIntervals.dependencyId, id),
            isNull(dependencyStateIntervals.endedAt)
          )
        )
      return true
    }
    // Runs on the caller's transaction when one is supplied (the idempotency
    // path) so the removal and the idempotency record commit atomically, or
    // opens its own transaction otherwise. Mirrors insertDependency's handle
    // choice: a handle equal to this module's own db is the unset default.
    if (handle && handle !== db) {
      return run(handle)
    }
    return db.transaction(run)
  },

  async patchNotifications(id, notificationsEnabled, handle) {
    // A single conditional update, so the caller's transaction handle (the
    // idempotency path) or the pooled db each commit it on their own. Passing
    // the handle keeps the update atomic with the idempotency record.
    const executor = handle && handle !== db ? handle : db
    const updated = await executor
      .update(dependencies)
      .set({ notificationsEnabled })
      .where(and(eq(dependencies.id, id), isNull(dependencies.removedAt)))
      .returning({ id: dependencies.id })
    return Boolean(updated[0])
  },
}
