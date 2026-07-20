import { describe, expect, it, vi } from "vitest";

import type { CatalogManifest } from "./manifest";
import type { DependencyPresetManifest } from "./manifest";
import {
  presetUpsertPlan,
  syncCatalog,
  validateCatalog,
  SOURCE_DROPPED_FROM_MANIFEST_ERROR,
  type CatalogSyncExecutor,
  type CatalogSyncStore,
  type CatalogValidationExecutor,
  type CatalogValidationStore,
  type StoredPresetDefinition,
} from "./catalog-sync";

function manifestWith(catalogVersion: string): CatalogManifest {
  return {
    schemaVersion: 1,
    catalogVersion,
    sources: [
      {
        id: "vercel",
        provider: "Vercel",
        adapter: "statuspage_v2",
        currentUrl: "https://www.vercel-status.com/api/v2/summary.json",
        incidentsUrl: "https://www.vercel-status.com/api/v2/incidents.json",
        statusPageUrl: "https://www.vercel-status.com/",
        allowedHosts: ["www.vercel-status.com"],
        operationalPollSeconds: 120,
        activePollSeconds: 60,
        staleAfterSeconds: 600,
        config: {},
      },
    ],
    presets: [
      {
        id: "vercel_runtime",
        sourceId: "vercel",
        name: "Vercel Runtime",
        category: "hosting",
        description: "Vercel Functions, CDN, routing middleware, and DNS.",
        selector: { kind: "component_ids", aggregation: "worst_of", ids: ["kgcsn9c73xzf"] },
        scope: null,
        sourceScopeNote: null,
        enabled: true,
      },
    ],
  };
}

function fakeSyncExecutor(
  storedVersion: string | null,
  options: { enabledSourceIds?: string[]; presetIdsBySource?: Record<string, string[]> } = {},
): CatalogSyncExecutor & {
  lock: ReturnType<typeof vi.fn>;
  upsertSource: ReturnType<typeof vi.fn>;
  upsertPreset: ReturnType<typeof vi.fn>;
  disableSource: ReturnType<typeof vi.fn>;
  disablePreset: ReturnType<typeof vi.fn>;
  flipDependenciesToUnknown: ReturnType<typeof vi.fn>;
} {
  const presetIdsBySource = options.presetIdsBySource ?? {};
  return {
    lock: vi.fn(async () => undefined),
    getStoredCatalogVersion: vi.fn(async () => storedVersion),
    upsertSource: vi.fn(async () => undefined),
    upsertPreset: vi.fn(async () => undefined),
    listEnabledSourceIds: vi.fn(async () => options.enabledSourceIds ?? []),
    disableSource: vi.fn(async () => undefined),
    listEnabledPresetIdsForSource: vi.fn(async (sourceId: string) => presetIdsBySource[sourceId] ?? []),
    disablePreset: vi.fn(async () => undefined),
    flipDependenciesToUnknown: vi.fn(async () => 0),
  };
}

function fakeSyncStore(executor: CatalogSyncExecutor): CatalogSyncStore {
  return { transaction: (work) => work(executor) };
}

describe("syncCatalog", () => {
  it("skips the upsert when the stored catalog version already matches the manifest", async () => {
    const manifest = manifestWith("2026-07-19.1");
    const executor = fakeSyncExecutor("2026-07-19.1");
    const result = await syncCatalog(fakeSyncStore(executor), manifest);

    expect(result).toEqual({ synced: false, catalogVersion: "2026-07-19.1", droppedSources: [] });
    expect(executor.lock).toHaveBeenCalledTimes(1);
    expect(executor.upsertSource).not.toHaveBeenCalled();
    expect(executor.upsertPreset).not.toHaveBeenCalled();
    expect(executor.listEnabledSourceIds).not.toHaveBeenCalled();
  });

  it("upserts every source and preset when the manifest version differs from the stored version", async () => {
    const manifest = manifestWith("2026-07-19.2");
    const executor = fakeSyncExecutor("2026-07-19.1", { enabledSourceIds: ["vercel"] });
    const result = await syncCatalog(fakeSyncStore(executor), manifest);

    expect(result).toEqual({ synced: true, catalogVersion: "2026-07-19.2", droppedSources: [] });
    expect(executor.upsertSource).toHaveBeenCalledTimes(1);
    expect(executor.upsertSource).toHaveBeenCalledWith(manifest.sources[0], "2026-07-19.2");
    expect(executor.upsertPreset).toHaveBeenCalledTimes(1);
    expect(executor.upsertPreset).toHaveBeenCalledWith(manifest.presets[0], "2026-07-19.2");
    expect(executor.disableSource).not.toHaveBeenCalled();
  });

  it("disables a source dropped from the manifest, records a validation error on its presets, and flips its dependencies to UNKNOWN", async () => {
    const manifest = manifestWith("2026-07-19.2");
    const observedAt = new Date("2026-07-19T00:00:00.000Z");
    const executor = fakeSyncExecutor("2026-07-19.1", {
      enabledSourceIds: ["vercel", "retired-provider"],
      presetIdsBySource: { "retired-provider": ["retired_runtime"] },
    });

    const result = await syncCatalog(fakeSyncStore(executor), manifest, () => observedAt);

    expect(result.droppedSources).toEqual(["retired-provider"]);
    expect(executor.disableSource).toHaveBeenCalledTimes(1);
    expect(executor.disableSource).toHaveBeenCalledWith("retired-provider", observedAt, SOURCE_DROPPED_FROM_MANIFEST_ERROR);
    expect(executor.disablePreset).toHaveBeenCalledTimes(1);
    expect(executor.disablePreset).toHaveBeenCalledWith("retired_runtime", observedAt, SOURCE_DROPPED_FROM_MANIFEST_ERROR);
    expect(executor.flipDependenciesToUnknown).toHaveBeenCalledTimes(1);
    expect(executor.flipDependenciesToUnknown).toHaveBeenCalledWith("retired_runtime", observedAt);
  });

  it("does not treat any source as dropped when the stored catalog version already matches", async () => {
    const manifest = manifestWith("2026-07-19.1");
    const executor = fakeSyncExecutor("2026-07-19.1", { enabledSourceIds: ["vercel", "retired-provider"] });
    const result = await syncCatalog(fakeSyncStore(executor), manifest);

    expect(result).toEqual({ synced: false, catalogVersion: "2026-07-19.1", droppedSources: [] });
    expect(executor.disableSource).not.toHaveBeenCalled();
  });

  it("syncs on first run when nothing is stored yet", async () => {
    const manifest = manifestWith("2026-07-19.1");
    const executor = fakeSyncExecutor(null);
    const result = await syncCatalog(fakeSyncStore(executor), manifest);
    expect(result.synced).toBe(true);
    expect(executor.upsertSource).toHaveBeenCalledTimes(1);
  });
});

function manifestPreset(overrides: Partial<DependencyPresetManifest> = {}): DependencyPresetManifest {
  return {
    id: "vercel_runtime",
    sourceId: "vercel",
    name: "Vercel Runtime",
    category: "hosting",
    description: "Vercel Functions, CDN, routing middleware, and DNS.",
    selector: { kind: "component_ids", aggregation: "worst_of", ids: ["kgcsn9c73xzf"] },
    scope: null,
    sourceScopeNote: null,
    enabled: true,
    ...overrides,
  };
}

function storedDefinition(overrides: Partial<StoredPresetDefinition> = {}): StoredPresetDefinition {
  return {
    sourceId: "vercel",
    selector: { kind: "component_ids", aggregation: "worst_of", ids: ["kgcsn9c73xzf"] },
    scope: null,
    ...overrides,
  };
}

describe("presetUpsertPlan", () => {
  it("starts a brand new preset (no stored row) unvalidated", () => {
    const plan = presetUpsertPlan(null, manifestPreset(), "2026-07-19.2");
    expect(plan.insert).toMatchObject({ validatedAt: null, validationError: null });
    expect(plan.update).toEqual(plan.insert);
  });

  it("preserves validation state across a version bump when the source, selector, and scope are unchanged", () => {
    const plan = presetUpsertPlan(storedDefinition(), manifestPreset({ name: "Vercel Runtime (renamed)" }), "2026-07-19.2");
    expect(plan.update).not.toHaveProperty("validatedAt");
    expect(plan.update).not.toHaveProperty("validationError");
    expect(plan.update).toMatchObject({ displayName: "Vercel Runtime (renamed)", catalogVersion: "2026-07-19.2" });
  });

  it("leaves the stored enabled flag untouched across a version bump when the definition is unchanged, so a drift-disabled preset is not re-enabled", () => {
    const plan = presetUpsertPlan(storedDefinition(), manifestPreset({ enabled: true }), "2026-07-19.2");
    expect(plan.update).not.toHaveProperty("enabled");
  });

  it("re-enables and resets validation state when the definition materially changed", () => {
    const plan = presetUpsertPlan(storedDefinition({ sourceId: "aws" }), manifestPreset({ enabled: true }), "2026-07-19.2");
    expect(plan.update).toMatchObject({ enabled: true, validatedAt: null, validationError: null });
  });

  it("starts a brand new preset enabled", () => {
    const plan = presetUpsertPlan(null, manifestPreset({ enabled: true }), "2026-07-19.2");
    expect(plan.insert).toMatchObject({ enabled: true });
  });

  it("preserves validation state when the scope's option key order differs (jsonb round-trip reordering, not a real change)", () => {
    const stored = storedDefinition({
      selector: { ids: ["kgcsn9c73xzf"], kind: "component_ids", aggregation: "worst_of" } as never,
    });
    const plan = presetUpsertPlan(stored, manifestPreset(), "2026-07-19.2");
    expect(plan.update).not.toHaveProperty("validatedAt");
  });

  it("resets validation state when the selector's component ids changed", () => {
    const plan = presetUpsertPlan(
      storedDefinition(),
      manifestPreset({ selector: { kind: "component_ids", aggregation: "worst_of", ids: ["a-different-id"] } }),
      "2026-07-19.2",
    );
    expect(plan.update).toMatchObject({ validatedAt: null, validationError: null });
  });

  it("resets validation state when the source changed", () => {
    const plan = presetUpsertPlan(storedDefinition({ sourceId: "aws" }), manifestPreset(), "2026-07-19.2");
    expect(plan.update).toMatchObject({ validatedAt: null, validationError: null });
  });

  it("resets validation state when the scope changed", () => {
    const plan = presetUpsertPlan(
      storedDefinition({ scope: null }),
      manifestPreset({ scope: { kind: "required_options", options: [{ id: "us-east-1", label: "AWS us-east-1" }] } }),
      "2026-07-19.2",
    );
    expect(plan.update).toMatchObject({ validatedAt: null, validationError: null });
  });
});

interface FakeValidationState {
  sources: Array<{ id: string; adapter: string; currentUrl: string }>;
  presetsBySource: Record<string, Array<{ id: string; selector: unknown; scope: unknown }>>;
  installedBySource: Record<string, number>;
}

function fakeValidationExecutor(state: FakeValidationState) {
  const recordSourceValidation = vi.fn(async () => undefined);
  const recordPresetValidationOk = vi.fn(async () => undefined);
  const disablePreset = vi.fn(async () => undefined);
  const flipDependenciesToUnknown = vi.fn(async (catalogId: string) => state.installedBySource[catalogId] ?? 0);

  const executor: CatalogValidationExecutor = {
    loadEnabledSources: async () => state.sources,
    loadEnabledPresetsForSource: async (sourceId) => (state.presetsBySource[sourceId] ?? []) as never,
    recordSourceValidation,
    recordPresetValidationOk,
    disablePreset,
    flipDependenciesToUnknown,
  };
  return { executor, recordSourceValidation, recordPresetValidationOk, disablePreset, flipDependenciesToUnknown };
}

function fakeValidationStore(executor: CatalogValidationExecutor): CatalogValidationStore {
  return { transaction: (work) => work(executor) };
}

describe("validateCatalog", () => {
  it("disables only the preset whose selector IDs are missing from the fetched directory", async () => {
    const state: FakeValidationState = {
      sources: [{ id: "vercel", adapter: "statuspage_v2", currentUrl: "https://www.vercel-status.com/api/v2/summary.json" }],
      presetsBySource: {
        vercel: [
          { id: "vercel_runtime", selector: { kind: "component_ids", aggregation: "worst_of", ids: ["kgcsn9c73xzf"] }, scope: null },
          { id: "vercel_deployments", selector: { kind: "component_ids", aggregation: "worst_of", ids: ["renamed-id"] }, scope: null },
        ],
      },
      installedBySource: { vercel_deployments: 2 },
    };
    const { executor, disablePreset, recordPresetValidationOk, flipDependenciesToUnknown } = fakeValidationExecutor(state);
    const fetchSourceComponents = vi.fn(async () => ({ componentIds: new Set(["kgcsn9c73xzf"]) }));

    const summary = await validateCatalog({
      store: fakeValidationStore(executor),
      fetchSourceComponents,
      now: () => new Date("2026-07-19T00:00:00.000Z"),
    });

    expect(summary.disabledPresets).toEqual(["vercel_deployments"]);
    expect(summary.validatedPresets).toBe(1);
    expect(disablePreset).toHaveBeenCalledTimes(1);
    expect(disablePreset).toHaveBeenCalledWith("vercel_deployments", new Date("2026-07-19T00:00:00.000Z"), expect.stringContaining("renamed-id"));
    expect(recordPresetValidationOk).toHaveBeenCalledWith("vercel_runtime", new Date("2026-07-19T00:00:00.000Z"));
    expect(flipDependenciesToUnknown).toHaveBeenCalledTimes(1);
    expect(flipDependenciesToUnknown).toHaveBeenCalledWith("vercel_deployments", new Date("2026-07-19T00:00:00.000Z"));
  });

  it("flips a disabled preset's installed dependencies to UNKNOWN and reports the count", async () => {
    const state: FakeValidationState = {
      sources: [{ id: "vercel", adapter: "statuspage_v2", currentUrl: "https://www.vercel-status.com/api/v2/summary.json" }],
      presetsBySource: {
        vercel: [{ id: "vercel_deployments", selector: { kind: "component_ids", aggregation: "worst_of", ids: ["missing"] }, scope: null }],
      },
      installedBySource: { vercel_deployments: 3 },
    };
    const { executor } = fakeValidationExecutor(state);
    const summary = await validateCatalog({
      store: fakeValidationStore(executor),
      fetchSourceComponents: vi.fn(async () => ({ componentIds: new Set<string>() })),
    });

    expect(summary.unknownDependencies).toBe(3);
    expect(summary.disabledPresets).toEqual(["vercel_deployments"]);
  });

  it("records a feed error without disabling any preset when the source cannot be fetched", async () => {
    const state: FakeValidationState = {
      sources: [{ id: "vercel", adapter: "statuspage_v2", currentUrl: "https://www.vercel-status.com/api/v2/summary.json" }],
      presetsBySource: {
        vercel: [{ id: "vercel_runtime", selector: { kind: "component_ids", aggregation: "worst_of", ids: ["kgcsn9c73xzf"] }, scope: null }],
      },
      installedBySource: {},
    };
    const { executor, recordSourceValidation, disablePreset } = fakeValidationExecutor(state);

    const summary = await validateCatalog({
      store: fakeValidationStore(executor),
      fetchSourceComponents: vi.fn(async () => null),
    });

    expect(recordSourceValidation).toHaveBeenCalledWith("vercel", expect.any(Date), "FEED_UNREACHABLE");
    expect(disablePreset).not.toHaveBeenCalled();
    expect(summary.disabledPresets).toEqual([]);
    expect(summary.checkedSources).toBe(1);
  });
});
