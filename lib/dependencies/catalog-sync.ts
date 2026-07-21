import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

import type { Database, DatabaseTransaction } from "@/lib/db/client";
import {
  dependencies,
  dependencyCatalog,
  dependencyDiscoveredScopeOptions,
  dependencySources,
  dependencyState,
  dependencyStateIntervals,
} from "@/lib/db/schema";

import { loadCatalogManifest, type CatalogManifest, type DependencyPresetManifest, type DependencySourceManifest } from "./manifest";
import type {
  CatalogComponentDirectory,
  CatalogDirectoryOption,
  DependencyFidelity,
  DependencyScope,
  DependencySelector,
} from "./types";

export type { CatalogComponentDirectory } from "./types";

// -- syncCatalog -------------------------------------------------------------
//
// Upserts the shipped manifest into Postgres, only when the stored catalog
// version differs. The executor is injected so tests exercise the upsert
// logic without a database, and the real implementation stays a thin Drizzle
// adapter below.
//
// A source can only disappear from the manifest when the catalog version
// changes, so a manifest version change is also the point where sources
// dropped from the manifest are detected and retired: each dropped source is
// disabled, its still-enabled presets get a validation error (the same
// mechanism reconcileCatalog uses when a preset's upstream id goes missing),
// and their installed dependencies flip to UNKNOWN through the same interval
// bookkeeping reconcileCatalog uses. Without this, a renamed or removed
// provider would leave its installs frozen at their last observed state with
// no error surfaced anywhere.

/** The message recorded on a source and its presets when the source id is no longer present in the shipped manifest. */
export const SOURCE_DROPPED_FROM_MANIFEST_ERROR = "Source is no longer present in the catalog manifest";

export interface CatalogSyncExecutor {
  lock(): Promise<void>;
  getStoredCatalogVersion(): Promise<string | null>;
  upsertSource(source: DependencySourceManifest, catalogVersion: string): Promise<void>;
  upsertPreset(preset: DependencyPresetManifest, catalogVersion: string, fidelity: DependencyFidelity): Promise<void>;
  listEnabledSourceIds(): Promise<string[]>;
  disableSource(sourceId: string, observedAt: Date, error: string): Promise<void>;
  listEnabledPresetIdsForSource(sourceId: string): Promise<string[]>;
  disablePreset(presetId: string, validatedAt: Date, error: string): Promise<void>;
  flipDependenciesToUnknown(catalogId: string, observedAt: Date): Promise<number>;
}

export interface CatalogSyncStore {
  transaction<T>(work: (tx: CatalogSyncExecutor) => Promise<T>): Promise<T>;
}

export interface CatalogSyncResult {
  synced: boolean;
  catalogVersion: string;
  droppedSources: string[];
}

/** Stored source ids no longer present in the manifest. A brand new manifest with the same sources as before yields an empty list. */
function droppedSourceIds(manifestSourceIds: ReadonlySet<string>, storedSourceIds: readonly string[]): string[] {
  return storedSourceIds.filter((id) => !manifestSourceIds.has(id));
}

export async function syncCatalog(
  db: CatalogSyncStore,
  manifest: CatalogManifest = loadCatalogManifest(),
  now: () => Date = () => new Date(),
): Promise<CatalogSyncResult> {
  return db.transaction(async (tx) => {
    await tx.lock();
    const storedVersion = await tx.getStoredCatalogVersion();
    if (storedVersion === manifest.catalogVersion) {
      return { synced: false, catalogVersion: manifest.catalogVersion, droppedSources: [] };
    }
    for (const source of manifest.sources) {
      await tx.upsertSource(source, manifest.catalogVersion);
    }
    const sourceFidelityById = new Map(manifest.sources.map((source) => [source.id, source.fidelity ?? "component"] as const));
    for (const preset of manifest.presets) {
      // Effective fidelity: the preset's own override, else its source's
      // fidelity, else the "component" default. Resolved here so the stored
      // catalog row carries one concrete value the reads never have to infer.
      const fidelity = preset.fidelity ?? sourceFidelityById.get(preset.sourceId) ?? "component";
      await tx.upsertPreset(preset, manifest.catalogVersion, fidelity);
    }

    const manifestSourceIds = new Set(manifest.sources.map((source) => source.id));
    const storedSourceIds = await tx.listEnabledSourceIds();
    const dropped = droppedSourceIds(manifestSourceIds, storedSourceIds);
    if (dropped.length > 0) {
      const observedAt = now();
      for (const sourceId of dropped) {
        await tx.disableSource(sourceId, observedAt, SOURCE_DROPPED_FROM_MANIFEST_ERROR);
        const presetIds = await tx.listEnabledPresetIdsForSource(sourceId);
        for (const presetId of presetIds) {
          await tx.disablePreset(presetId, observedAt, SOURCE_DROPPED_FROM_MANIFEST_ERROR);
          await tx.flipDependenciesToUnknown(presetId, observedAt);
        }
      }
    }

    return { synced: true, catalogVersion: manifest.catalogVersion, droppedSources: dropped };
  });
}

/** The stored fields reconcileCatalog actually checks against the live feed, as opposed to display copy that never affects validation state. */
export interface StoredPresetDefinition {
  sourceId: string;
  selector: DependencySelector;
  scope: DependencyScope | null;
}

export interface PresetUpsertPlan {
  insert: typeof dependencyCatalog.$inferInsert;
  update: Partial<typeof dependencyCatalog.$inferInsert>;
}

/** JSON.stringify with object keys sorted, so a jsonb round-trip's key reordering never reads as a definition change. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.keys(val).sort().reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = (val as Record<string, unknown>)[key];
        return sorted;
      }, {});
    }
    return val;
  });
}

/** True when the preset's source, selector, or scope differs from what's stored, the only fields reconcileCatalog checks. A brand new preset (no stored row) always counts as changed. */
function presetDefinitionChanged(existing: StoredPresetDefinition | null, preset: DependencyPresetManifest): boolean {
  if (!existing) return true;
  return existing.sourceId !== preset.sourceId
    || canonicalJson(existing.selector) !== canonicalJson(preset.selector)
    || canonicalJson(existing.scope) !== canonicalJson(preset.scope);
}

/**
 * Values for upserting one preset. A catalog version bump alone must never
 * erase what catalog validation already found, so the update only resets
 * enabled, validatedAt, and validationError when the source, selector, or
 * scope materially changed from what's stored. Display copy (name,
 * description, category, sourceScopeNote) changing on its own preserves the
 * existing validation state and enabled flag, so a version bump can never
 * re-enable a preset that drift detection intentionally disabled. A brand
 * new preset always starts enabled and unvalidated, and a materially changed
 * one legitimately resets to the manifest's enabled default.
 */
export function presetUpsertPlan(
  existing: StoredPresetDefinition | null,
  preset: DependencyPresetManifest,
  catalogVersion: string,
  fidelity: DependencyFidelity = "component",
): PresetUpsertPlan {
  const shared = {
    id: preset.id,
    sourceId: preset.sourceId,
    displayName: preset.name,
    category: preset.category,
    description: preset.description,
    selector: preset.selector,
    scopeOptions: preset.scope,
    sourceScopeNote: preset.sourceScopeNote,
    // Fidelity is display and behavior metadata, not selector identity, so it
    // rides in shared and updates on every version bump without resetting
    // validation state, exactly like displayName and description.
    fidelity,
    catalogVersion,
  };
  const insert = { ...shared, enabled: preset.enabled, validatedAt: null, validationError: null };
  const update = presetDefinitionChanged(existing, preset) ? insert : shared;
  return { insert, update };
}

export interface SourceUpsertPlan {
  insert: typeof dependencySources.$inferInsert;
  update: Partial<typeof dependencySources.$inferInsert>;
}

/**
 * Values for upserting one source. upsertSource only ever runs during a
 * catalog version change (syncCatalog upserts nothing when the stored
 * version already matches), so the conflict update legitimately resets the
 * cache validators: when currentUrl changes across the version bump, a
 * stored etag or last-modified from the prior url would otherwise ride along
 * and draw a spurious 304 against the new url, short circuiting primary-only
 * adapters. Clearing etag and lastModified, and nulling nextPollAt so the
 * scheduler treats the source as due, forces one fresh unconditional fetch.
 */
export function sourceUpsertPlan(source: DependencySourceManifest, catalogVersion: string): SourceUpsertPlan {
  const insert = {
    id: source.id,
    providerName: source.provider,
    adapter: source.adapter,
    currentUrl: source.currentUrl,
    incidentsUrl: source.incidentsUrl,
    statusPageUrl: source.statusPageUrl,
    allowedHosts: source.allowedHosts,
    config: source.config,
    catalogVersion,
    enabled: true,
  };
  const update = {
    providerName: source.provider,
    adapter: source.adapter,
    currentUrl: source.currentUrl,
    incidentsUrl: source.incidentsUrl,
    statusPageUrl: source.statusPageUrl,
    allowedHosts: source.allowedHosts,
    config: source.config,
    catalogVersion,
    enabled: true,
    etag: null,
    lastModified: null,
    nextPollAt: null,
  };
  return { insert, update };
}

/** Disables a preset and records why, shared by reconcileCatalog (a missing upstream id) and syncCatalog (the preset's source dropped from the manifest). */
async function disablePresetSql(tx: DatabaseTransaction, presetId: string, validatedAt: Date, error: string): Promise<void> {
  await tx.update(dependencyCatalog).set({ enabled: false, validatedAt, validationError: error }).where(eq(dependencyCatalog.id, presetId));
}

/**
 * Flips every installed, non-removed dependency under a catalog preset to
 * UNKNOWN, shared by reconcileCatalog and syncCatalog. Change-only storage:
 * only dependencies not already UNKNOWN get a closed-then-reopened interval,
 * so re-disabling an already-UNKNOWN preset doesn't churn out a fresh
 * interval for nothing. Transition bookkeeping mirrors
 * persist.applyDependencyState: a transitioning row advances stateStartedAt
 * and its open interval closes with greatest(observedAt, started_at).
 */
export async function flipDependenciesToUnknownSql(tx: DatabaseTransaction, catalogId: string, observedAt: Date): Promise<number> {
  const installed = await tx.select({ id: dependencies.id, state: dependencyState.state })
    .from(dependencies)
    .innerJoin(dependencyState, eq(dependencyState.dependencyId, dependencies.id))
    .where(and(eq(dependencies.catalogId, catalogId), isNull(dependencies.removedAt)));
  if (installed.length === 0) return 0;

  const ids = installed.map((row) => row.id);
  await tx.update(dependencyState).set({ state: "UNKNOWN", pendingFirstPoll: false, observedAt })
    .where(inArray(dependencyState.dependencyId, ids));

  const transitioning = installed.filter((row) => row.state !== "UNKNOWN").map((row) => row.id);
  if (transitioning.length > 0) {
    // stateStartedAt only advances for rows whose state actually changed,
    // so an already-UNKNOWN install keeps its original start.
    await tx.update(dependencyState).set({ stateStartedAt: observedAt })
      .where(inArray(dependencyState.dependencyId, transitioning));
    // greatest(observedAt, started_at) rather than a bare observedAt: under
    // cross-instance clock skew a slightly-behind observedAt could otherwise
    // land before the interval's own started_at and fail the
    // ended_at >= started_at check, aborting the whole sync transaction.
    // Bound as an ISO string, never a Date: raw sql params bypass drizzle's
    // column mappers and postgres-js rejects a Date at the wire layer.
    await tx.update(dependencyStateIntervals).set({ endedAt: sql`greatest(${observedAt.toISOString()}, ${dependencyStateIntervals.startedAt})` })
      .where(and(inArray(dependencyStateIntervals.dependencyId, transitioning), isNull(dependencyStateIntervals.endedAt)));
    await tx.insert(dependencyStateIntervals).values(transitioning.map((dependencyId) => ({
      id: randomUUID(),
      dependencyId,
      state: "UNKNOWN" as const,
      startedAt: observedAt,
      endedAt: null,
      sourceObservedAt: observedAt,
    })));
  }

  return ids.length;
}

export function createSqlCatalogSyncStore(db: Database): CatalogSyncStore {
  return {
    transaction: (work) => db.transaction(async (tx) => work({
      lock: async () => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('pulse:dependency-catalog'))`);
      },
      getStoredCatalogVersion: async () => {
        const [row] = await tx.select({ catalogVersion: dependencySources.catalogVersion }).from(dependencySources).limit(1);
        return row?.catalogVersion ?? null;
      },
      upsertSource: async (source, catalogVersion) => {
        const plan = sourceUpsertPlan(source, catalogVersion);
        await tx.insert(dependencySources).values(plan.insert).onConflictDoUpdate({
          target: dependencySources.id,
          set: plan.update,
        });
      },
      upsertPreset: async (preset, catalogVersion, fidelity) => {
        const [existing] = await tx.select({
          sourceId: dependencyCatalog.sourceId,
          selector: dependencyCatalog.selector,
          scopeOptions: dependencyCatalog.scopeOptions,
        }).from(dependencyCatalog).where(eq(dependencyCatalog.id, preset.id)).limit(1);
        const plan = presetUpsertPlan(
          existing
            ? {
                sourceId: existing.sourceId,
                selector: existing.selector as DependencySelector,
                scope: (existing.scopeOptions as DependencyScope | null) ?? null,
              }
            : null,
          preset,
          catalogVersion,
          fidelity,
        );
        await tx.insert(dependencyCatalog).values(plan.insert).onConflictDoUpdate({
          target: dependencyCatalog.id,
          set: plan.update,
        });
      },
      listEnabledSourceIds: async () =>
        (await tx.select({ id: dependencySources.id }).from(dependencySources).where(eq(dependencySources.enabled, true)))
          .map((row) => row.id),
      disableSource: async (sourceId, observedAt, error) => {
        await tx.update(dependencySources).set({ enabled: false, catalogValidatedAt: observedAt, catalogValidationError: error })
          .where(eq(dependencySources.id, sourceId));
      },
      listEnabledPresetIdsForSource: async (sourceId) =>
        (await tx.select({ id: dependencyCatalog.id }).from(dependencyCatalog)
          .where(and(eq(dependencyCatalog.sourceId, sourceId), eq(dependencyCatalog.enabled, true))))
          .map((row) => row.id),
      disablePreset: (presetId, validatedAt, error) => disablePresetSql(tx, presetId, validatedAt, error),
      flipDependenciesToUnknown: (catalogId, observedAt) => flipDependenciesToUnknownSql(tx, catalogId, observedAt),
    })),
  };
}

// -- reconcileCatalog ---------------------------------------------------------
//
// Fetches each enabled source once (through the injected fetcher) and checks
// that the selector's upstream IDs are still present. A source that cannot be
// reached records a validation error without touching any preset, matching
// the "feed failure never produces a false outage" rule. A source that
// responds but is missing an ID disables only the affected preset and flips
// its installed dependencies to UNKNOWN. Preset IDs are the only durable
// identity per the catalog contract, so drift detection never matches by name.
//
// A complete directory also materialises discovered scope options for presets
// with discovered_children or discovered_locations. Failed/incomplete fetches
// leave availability untouched.

export type FetchCatalogDirectory = (args: {
  source: {
    id: string;
    adapter: string;
    currentUrl: string;
  };
  deadlineAtMs?: number;
  nowMs?: () => number;
}) => Promise<CatalogComponentDirectory | null>;

/** @deprecated Prefer FetchCatalogDirectory. Alias kept while call sites migrate. */
export type FetchSourceComponents = FetchCatalogDirectory;

interface EnabledSourceRow {
  id: string;
  adapter: string;
  currentUrl: string;
}

interface PresetRow {
  id: string;
  selector: DependencySelector;
  scope: DependencyScope | null;
  /** Whether the preset is currently enabled. A drift-disabled preset (enabled false) still loads here so it can be re-enabled once its ids return. */
  enabled: boolean;
}

export type DiscoveredScopeKind = "discovered_child" | "discovered_location";

export type ObservedScopeOption = {
  scopeId: string;
  label: string;
  scopeKind: DiscoveredScopeKind;
  parentExternalId: string | null;
  metadata?: Record<string, unknown>;
};

export interface CatalogReconcileExecutor {
  /** Enabled presets plus drift-disabled ones (validationError set) for the source, so a preset frozen by transient drift can re-enable once its ids return. A manifest-shipped disabled preset (no validationError) is not loaded. */
  loadPresetsForSource(sourceId: string): Promise<PresetRow[]>;
  recordSourceValidation(sourceId: string, validatedAt: Date, error: string | null): Promise<void>;
  recordPresetValidationOk(presetId: string, validatedAt: Date): Promise<void>;
  /** Re-enables a drift-disabled preset whose ids are present again, clearing the validation error so its installs recompute on the next poll. */
  reEnablePreset(presetId: string, validatedAt: Date): Promise<void>;
  disablePreset(presetId: string, validatedAt: Date, error: string): Promise<void>;
  flipDependenciesToUnknown(catalogId: string, observedAt: Date): Promise<number>;
  /**
   * Transactional scope option sync for one catalog preset. Upserts observed
   * options as available with refreshed label and last_seen_at, and marks any
   * previously stored option not in observed as available=false. The observedAt
   * timestamp is the consistency boundary for unavailable marks.
   */
  syncDiscoveredScopeOptions(catalogId: string, observed: readonly ObservedScopeOption[], observedAt: Date): Promise<void>;
}

export interface CatalogReconcileStore {
  /** Enabled sources, read outside any write transaction so the live fetches that follow hold no database connection. */
  loadEnabledSources(): Promise<EnabledSourceRow[]>;
  transaction<T>(work: (tx: CatalogReconcileExecutor) => Promise<T>): Promise<T>;
}

export interface ReconcileCatalogDeps {
  store: CatalogReconcileStore;
  /** Live complete directory fetcher. Null means feed failure: no availability changes. */
  fetchCatalogDirectory: FetchCatalogDirectory;
  /**
   * @deprecated Prefer fetchCatalogDirectory. When only this is set, it is used
   * as the directory fetcher so older call sites keep working during rename.
   */
  fetchSourceComponents?: FetchCatalogDirectory;
  now?: () => Date;
  /** Monotonic epoch-ms clock, injected so a test can drive the deadline. Defaults to Date.now. */
  nowMs?: () => number;
  /** Epoch-ms budget boundary. No new source fetch starts once nowMs reaches it, so validation cannot overrun the reserved maintenance slice. Undefined means no bound. */
  deadlineAtMs?: number;
}

export interface ReconcileCatalogSummary {
  checkedSources: number;
  validatedPresets: number;
  disabledPresets: string[];
  unknownDependencies: number;
}

function selectorRequiredIds(selector: DependencySelector): string[] {
  switch (selector.kind) {
    case "component_ids":
      return selector.ids;
    case "google_product":
      return [selector.productId];
    case "statusio_component_container":
      return [selector.componentId];
  }
}

/**
 * IDs whose absence disables the whole preset: the selector's core upstream
 * ids only. A required_options scope's region container ids are deliberately
 * not preset-level required. Status.io dropping one region out of many must
 * not disable the preset and freeze every region's installs. A dropped
 * region resolves per install through the poller: resolveDependencyState
 * returns UNKNOWN for an install scoped to a now-absent container, while
 * installs scoped to still-present regions keep polling healthy. Only
 * statically known selector ids are checked here. discovered-children and
 * discovered-locations scopes materialise options from the directory below.
 */
function missingIds(preset: PresetRow, known: ReadonlySet<string>): string[] {
  return selectorRequiredIds(preset.selector).filter((id) => !known.has(id));
}

function mapOptions(
  options: readonly CatalogDirectoryOption[],
  scopeKind: DiscoveredScopeKind,
  parentExternalId: string | null,
): ObservedScopeOption[] {
  return options.map((option) => ({
    scopeId: option.id,
    label: option.label,
    scopeKind,
    parentExternalId,
    metadata: option.metadata,
  }));
}

/**
 * Observed scope options for one preset drawn from a complete directory.
 * discovered_children resolves against childrenByParent[groupId].
 * discovered_locations resolves against locationsByProduct[productId].
 * Returns null when the preset has no discovered scope contract.
 */
export function observedScopeOptionsForPreset(
  preset: Pick<PresetRow, "selector" | "scope">,
  directory: CatalogComponentDirectory,
): ObservedScopeOption[] | null {
  const scope = preset.scope;
  if (!scope) return null;
  if (scope.kind === "discovered_children") {
    const children = directory.childrenByParent.get(scope.groupId) ?? [];
    return mapOptions(children, "discovered_child", scope.groupId);
  }
  if (scope.kind === "discovered_locations") {
    const productId = preset.selector.kind === "google_product" ? preset.selector.productId : null;
    const locations = productId ? (directory.locationsByProduct.get(productId) ?? []) : [];
    return mapOptions(locations, "discovered_location", productId);
  }
  return null;
}

/**
 * Pure plan for one catalog_id's discovered scope rows. Tests assert the
 * upsert/unavailable split without a database. observedAt is the consistency
 * boundary: unobserved prior rows become available=false at that timestamp.
 */
export function planDiscoveredScopeSync(
  prior: ReadonlyArray<{ scopeId: string }>,
  observed: readonly ObservedScopeOption[],
  observedAt: Date,
): {
  upserts: Array<ObservedScopeOption & { available: true; lastSeenAt: Date }>;
  unavailableScopeIds: string[];
  observedAt: Date;
} {
  const observedIds = new Set(observed.map((option) => option.scopeId));
  return {
    upserts: observed.map((option) => ({ ...option, available: true as const, lastSeenAt: observedAt })),
    unavailableScopeIds: prior.map((row) => row.scopeId).filter((scopeId) => !observedIds.has(scopeId)),
    observedAt,
  };
}

/**
 * Transactional materialisation of discovered scope options for one preset.
 * Call only after a complete directory fetch. Failed/timeout paths must not
 * invoke this so prior availability is preserved.
 */
export async function syncDiscoveredScopeOptionsSql(
  tx: DatabaseTransaction,
  catalogId: string,
  observed: readonly ObservedScopeOption[],
  observedAt: Date,
): Promise<void> {
  const prior = await tx.select({ scopeId: dependencyDiscoveredScopeOptions.scopeId })
    .from(dependencyDiscoveredScopeOptions)
    .where(eq(dependencyDiscoveredScopeOptions.catalogId, catalogId));
  const plan = planDiscoveredScopeSync(prior, observed, observedAt);

  for (const option of plan.upserts) {
    await tx.insert(dependencyDiscoveredScopeOptions).values({
      catalogId,
      scopeId: option.scopeId,
      label: option.label,
      scopeKind: option.scopeKind,
      parentExternalId: option.parentExternalId,
      available: true,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      metadata: option.metadata ?? null,
    }).onConflictDoUpdate({
      target: [dependencyDiscoveredScopeOptions.catalogId, dependencyDiscoveredScopeOptions.scopeId],
      set: {
        label: option.label,
        scopeKind: option.scopeKind,
        parentExternalId: option.parentExternalId,
        available: true,
        lastSeenAt: observedAt,
        metadata: option.metadata ?? null,
      },
    });
  }

  if (plan.unavailableScopeIds.length > 0) {
    await tx.update(dependencyDiscoveredScopeOptions)
      .set({ available: false })
      .where(and(
        eq(dependencyDiscoveredScopeOptions.catalogId, catalogId),
        inArray(dependencyDiscoveredScopeOptions.scopeId, plan.unavailableScopeIds),
      ));
  }
}

export async function reconcileCatalog(deps: ReconcileCatalogDeps): Promise<ReconcileCatalogSummary> {
  const now = deps.now ?? (() => new Date());
  const nowMs = deps.nowMs ?? Date.now;
  const deadlineAtMs = deps.deadlineAtMs ?? Infinity;
  const fetchDirectory = deps.fetchCatalogDirectory ?? deps.fetchSourceComponents;
  if (!fetchDirectory) {
    throw new Error("reconcileCatalog requires fetchCatalogDirectory");
  }
  const sources = await deps.store.loadEnabledSources();

  // Fetch each enabled source's component directory with no transaction open.
  // These are live, sequential, multi-source HTTP calls that can take tens of
  // seconds, so running them inside a transaction would pin a connection and
  // risk an idle_in_transaction abort that rolls back all partial validation.
  // The loop stops before starting the next source's fetch once the deadline
  // is reached, so validation stays inside its reserved maintenance slice.
  // Sources fetched this pass keep their results, the rest are simply left for
  // the next maintenance pass, and only the processed sources are validated
  // and counted below.
  const processed: EnabledSourceRow[] = [];
  const directories = new Map<string, CatalogComponentDirectory | null>();
  for (const source of sources) {
    if (nowMs() >= deadlineAtMs) break;
    // Per-source collection inherits the remaining maintenance slice so a slow
    // paginated feed cannot overrun the reserved catalog window.
    directories.set(source.id, await fetchDirectory({
      source,
      deadlineAtMs,
      nowMs,
    }));
    processed.push(source);
  }

  const disabledPresets: string[] = [];
  let validatedPresets = 0;
  let unknownDependencies = 0;

  // One short write transaction per processed source. Network already happened
  // above, so each transaction only issues local writes, and a failure
  // isolates to its own source instead of discarding every source's validation.
  // Directory data and scope option availability commit only after a complete
  // directory was produced, so the sync timestamp is the consistency boundary.
  for (const source of processed) {
    const directory = directories.get(source.id) ?? null;
    const perSource = await deps.store.transaction(async (tx) => {
      const validatedAt = now();
      if (!directory || !directory.complete) {
        // Incomplete or failed fetch: record feed error when null, and never
        // revise discovered scope availability from a partial page set.
        await tx.recordSourceValidation(source.id, validatedAt, "FEED_UNREACHABLE");
        return { validated: 0, disabled: [] as string[], unknown: 0 };
      }
      await tx.recordSourceValidation(source.id, validatedAt, null);

      const disabled: string[] = [];
      let validated = 0;
      let unknown = 0;
      const presets = await tx.loadPresetsForSource(source.id);
      for (const preset of presets) {
        const missing = directory.tracksComponents
          ? missingIds(preset, directory.componentIds)
          : [];
        if (missing.length > 0) {
          // An already drift-disabled preset whose ids are still missing
          // stays disabled untouched, so its installs are not re-flipped.
          if (!preset.enabled) continue;
          await tx.disablePreset(preset.id, validatedAt, `Missing upstream component ids: ${missing.join(", ")}`);
          disabled.push(preset.id);
          unknown += await tx.flipDependenciesToUnknown(preset.id, validatedAt);
          continue;
        }
        // A drift-disabled preset whose ids returned re-enables, so its
        // frozen installs recompute on the next poll. An enabled preset just
        // records the successful validation.
        if (preset.enabled) {
          await tx.recordPresetValidationOk(preset.id, validatedAt);
        } else {
          await tx.reEnablePreset(preset.id, validatedAt);
        }
        validated += 1;

        // Materialise discovered scope options only for presets whose core
        // selector ids are present. The complete directory is the sole source
        // of truth for availability this pass.
        const observed = observedScopeOptionsForPreset(preset, directory);
        if (observed) {
          await tx.syncDiscoveredScopeOptions(preset.id, observed, validatedAt);
        }
      }
      return { validated, disabled, unknown };
    });
    validatedPresets += perSource.validated;
    disabledPresets.push(...perSource.disabled);
    unknownDependencies += perSource.unknown;
  }

  return { checkedSources: processed.length, validatedPresets, disabledPresets, unknownDependencies };
}

export function createSqlCatalogReconcileStore(db: Database): CatalogReconcileStore {
  return {
    loadEnabledSources: async () =>
      db.select({ id: dependencySources.id, adapter: dependencySources.adapter, currentUrl: dependencySources.currentUrl })
        .from(dependencySources).where(eq(dependencySources.enabled, true)),
    transaction: (work) => db.transaction(async (tx) => work({
      loadPresetsForSource: async (sourceId) =>
        (await tx.select({ id: dependencyCatalog.id, selector: dependencyCatalog.selector, scope: dependencyCatalog.scopeOptions, enabled: dependencyCatalog.enabled })
          .from(dependencyCatalog)
          .where(and(
            eq(dependencyCatalog.sourceId, sourceId),
            or(eq(dependencyCatalog.enabled, true), isNotNull(dependencyCatalog.validationError)),
          ))) as PresetRow[],
      recordSourceValidation: async (sourceId, validatedAt, error) => {
        await tx.update(dependencySources).set({ catalogValidatedAt: validatedAt, catalogValidationError: error }).where(eq(dependencySources.id, sourceId));
      },
      recordPresetValidationOk: async (presetId, validatedAt) => {
        await tx.update(dependencyCatalog).set({ validatedAt, validationError: null }).where(eq(dependencyCatalog.id, presetId));
      },
      reEnablePreset: async (presetId, validatedAt) => {
        await tx.update(dependencyCatalog).set({ enabled: true, validatedAt, validationError: null }).where(eq(dependencyCatalog.id, presetId));
      },
      disablePreset: (presetId, validatedAt, error) => disablePresetSql(tx, presetId, validatedAt, error),
      flipDependenciesToUnknown: (catalogId, observedAt) => flipDependenciesToUnknownSql(tx, catalogId, observedAt),
      syncDiscoveredScopeOptions: (catalogId, observed, observedAt) =>
        syncDiscoveredScopeOptionsSql(tx, catalogId, observed, observedAt),
    })),
  };
}
