import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Database } from "@/lib/db/client";
import { dependencies, dependencyCatalog, dependencySources, dependencyState } from "@/lib/db/schema";

import { loadCatalogManifest, type CatalogManifest, type DependencyPresetManifest, type DependencySourceManifest } from "./manifest";
import type { DependencyScope, DependencySelector } from "./types";

// -- syncCatalog -------------------------------------------------------------
//
// Upserts the shipped manifest into Postgres, only when the stored catalog
// version differs. The executor is injected so tests exercise the upsert
// logic without a database, and the real implementation stays a thin Drizzle
// adapter below.

export interface CatalogSyncExecutor {
  lock(): Promise<void>;
  getStoredCatalogVersion(): Promise<string | null>;
  upsertSource(source: DependencySourceManifest, catalogVersion: string): Promise<void>;
  upsertPreset(preset: DependencyPresetManifest, catalogVersion: string): Promise<void>;
}

export interface CatalogSyncStore {
  transaction<T>(work: (tx: CatalogSyncExecutor) => Promise<T>): Promise<T>;
}

export interface CatalogSyncResult {
  synced: boolean;
  catalogVersion: string;
}

export async function syncCatalog(
  db: CatalogSyncStore,
  manifest: CatalogManifest = loadCatalogManifest(),
): Promise<CatalogSyncResult> {
  return db.transaction(async (tx) => {
    await tx.lock();
    const storedVersion = await tx.getStoredCatalogVersion();
    if (storedVersion === manifest.catalogVersion) {
      return { synced: false, catalogVersion: manifest.catalogVersion };
    }
    for (const source of manifest.sources) {
      await tx.upsertSource(source, manifest.catalogVersion);
    }
    for (const preset of manifest.presets) {
      await tx.upsertPreset(preset, manifest.catalogVersion);
    }
    return { synced: true, catalogVersion: manifest.catalogVersion };
  });
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
        const values = {
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
        await tx.insert(dependencySources).values(values).onConflictDoUpdate({
          target: dependencySources.id,
          set: values,
        });
      },
      upsertPreset: async (preset, catalogVersion) => {
        const values = {
          id: preset.id,
          sourceId: preset.sourceId,
          displayName: preset.name,
          category: preset.category,
          description: preset.description,
          selector: preset.selector,
          scopeOptions: preset.scope,
          sourceScopeNote: preset.sourceScopeNote,
          catalogVersion,
          enabled: preset.enabled,
          validatedAt: null,
          validationError: null,
        };
        await tx.insert(dependencyCatalog).values(values).onConflictDoUpdate({
          target: dependencyCatalog.id,
          set: values,
        });
      },
    })),
  };
}

// -- validateCatalog ----------------------------------------------------------
//
// Fetches each enabled source once (through the injected fetcher) and checks
// that the selector's upstream IDs are still present. A source that cannot be
// reached records a validation error without touching any preset, matching
// the "feed failure never produces a false outage" rule. A source that
// responds but is missing an ID disables only the affected preset and flips
// its installed dependencies to UNKNOWN. Preset IDs are the only durable
// identity per the catalog contract, so drift detection never matches by name.

/** The set of upstream IDs (components, products, or containers) a source's feed currently exposes. */
export interface CatalogComponentDirectory {
  componentIds: ReadonlySet<string>;
}

export type FetchSourceComponents = (source: {
  id: string;
  adapter: string;
  currentUrl: string;
}) => Promise<CatalogComponentDirectory | null>;

interface EnabledSourceRow {
  id: string;
  adapter: string;
  currentUrl: string;
}

interface EnabledPresetRow {
  id: string;
  selector: DependencySelector;
  scope: DependencyScope | null;
}

export interface CatalogValidationExecutor {
  loadEnabledSources(): Promise<EnabledSourceRow[]>;
  loadEnabledPresetsForSource(sourceId: string): Promise<EnabledPresetRow[]>;
  recordSourceValidation(sourceId: string, validatedAt: Date, error: string | null): Promise<void>;
  recordPresetValidationOk(presetId: string, validatedAt: Date): Promise<void>;
  disablePreset(presetId: string, validatedAt: Date, error: string): Promise<void>;
  flipDependenciesToUnknown(catalogId: string, observedAt: Date): Promise<number>;
}

export interface CatalogValidationStore {
  transaction<T>(work: (tx: CatalogValidationExecutor) => Promise<T>): Promise<T>;
}

export interface ValidateCatalogDeps {
  store: CatalogValidationStore;
  fetchSourceComponents: FetchSourceComponents;
  now?: () => Date;
}

export interface ValidateCatalogSummary {
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

function scopeRequiredIds(scope: DependencyScope | null): string[] {
  return scope?.kind === "required_options" ? scope.options.map((option) => option.id) : [];
}

/** IDs the preset needs that are absent from the fetched directory. Only checks statically known IDs; discovered-children and discovered-locations scopes are validated when their children are fetched. */
function missingIds(preset: EnabledPresetRow, known: ReadonlySet<string>): string[] {
  const required = [...selectorRequiredIds(preset.selector), ...scopeRequiredIds(preset.scope)];
  return required.filter((id) => !known.has(id));
}

export async function validateCatalog(deps: ValidateCatalogDeps): Promise<ValidateCatalogSummary> {
  const now = deps.now ?? (() => new Date());
  return deps.store.transaction(async (tx) => {
    const sources = await tx.loadEnabledSources();
    const disabledPresets: string[] = [];
    let validatedPresets = 0;
    let unknownDependencies = 0;

    for (const source of sources) {
      const directory = await deps.fetchSourceComponents(source);
      const validatedAt = now();
      if (!directory) {
        await tx.recordSourceValidation(source.id, validatedAt, "FEED_UNREACHABLE");
        continue;
      }
      await tx.recordSourceValidation(source.id, validatedAt, null);

      const presets = await tx.loadEnabledPresetsForSource(source.id);
      for (const preset of presets) {
        const missing = missingIds(preset, directory.componentIds);
        if (missing.length === 0) {
          await tx.recordPresetValidationOk(preset.id, validatedAt);
          validatedPresets += 1;
          continue;
        }
        await tx.disablePreset(preset.id, validatedAt, `Missing upstream component ids: ${missing.join(", ")}`);
        disabledPresets.push(preset.id);
        unknownDependencies += await tx.flipDependenciesToUnknown(preset.id, validatedAt);
      }
    }

    return { checkedSources: sources.length, validatedPresets, disabledPresets, unknownDependencies };
  });
}

export function createSqlCatalogValidationStore(db: Database): CatalogValidationStore {
  return {
    transaction: (work) => db.transaction(async (tx) => work({
      loadEnabledSources: async () =>
        tx.select({ id: dependencySources.id, adapter: dependencySources.adapter, currentUrl: dependencySources.currentUrl })
          .from(dependencySources).where(eq(dependencySources.enabled, true)),
      loadEnabledPresetsForSource: async (sourceId) =>
        (await tx.select({ id: dependencyCatalog.id, selector: dependencyCatalog.selector, scope: dependencyCatalog.scopeOptions })
          .from(dependencyCatalog)
          .where(and(eq(dependencyCatalog.sourceId, sourceId), eq(dependencyCatalog.enabled, true)))) as EnabledPresetRow[],
      recordSourceValidation: async (sourceId, validatedAt, error) => {
        await tx.update(dependencySources).set({ catalogValidatedAt: validatedAt, catalogValidationError: error }).where(eq(dependencySources.id, sourceId));
      },
      recordPresetValidationOk: async (presetId, validatedAt) => {
        await tx.update(dependencyCatalog).set({ validatedAt, validationError: null }).where(eq(dependencyCatalog.id, presetId));
      },
      disablePreset: async (presetId, validatedAt, error) => {
        await tx.update(dependencyCatalog).set({ enabled: false, validatedAt, validationError: error }).where(eq(dependencyCatalog.id, presetId));
      },
      flipDependenciesToUnknown: async (catalogId, observedAt) => {
        const installed = await tx.select({ id: dependencies.id }).from(dependencies)
          .where(and(eq(dependencies.catalogId, catalogId), isNull(dependencies.removedAt)));
        const ids = installed.map((row) => row.id);
        if (ids.length === 0) return 0;
        await tx.update(dependencyState).set({ state: "UNKNOWN", checking: false, observedAt })
          .where(inArray(dependencyState.dependencyId, ids));
        return ids.length;
      },
    })),
  };
}
