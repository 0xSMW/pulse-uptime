import { describe, expect, it, vi } from "vitest";

import type { CatalogManifest } from "./manifest";
import {
  syncCatalog,
  validateCatalog,
  type CatalogSyncExecutor,
  type CatalogSyncStore,
  type CatalogValidationExecutor,
  type CatalogValidationStore,
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

function fakeSyncExecutor(storedVersion: string | null): CatalogSyncExecutor & {
  lock: ReturnType<typeof vi.fn>;
  upsertSource: ReturnType<typeof vi.fn>;
  upsertPreset: ReturnType<typeof vi.fn>;
} {
  return {
    lock: vi.fn(async () => undefined),
    getStoredCatalogVersion: vi.fn(async () => storedVersion),
    upsertSource: vi.fn(async () => undefined),
    upsertPreset: vi.fn(async () => undefined),
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

    expect(result).toEqual({ synced: false, catalogVersion: "2026-07-19.1" });
    expect(executor.lock).toHaveBeenCalledTimes(1);
    expect(executor.upsertSource).not.toHaveBeenCalled();
    expect(executor.upsertPreset).not.toHaveBeenCalled();
  });

  it("upserts every source and preset when the manifest version differs from the stored version", async () => {
    const manifest = manifestWith("2026-07-19.2");
    const executor = fakeSyncExecutor("2026-07-19.1");
    const result = await syncCatalog(fakeSyncStore(executor), manifest);

    expect(result).toEqual({ synced: true, catalogVersion: "2026-07-19.2" });
    expect(executor.upsertSource).toHaveBeenCalledTimes(1);
    expect(executor.upsertSource).toHaveBeenCalledWith(manifest.sources[0], "2026-07-19.2");
    expect(executor.upsertPreset).toHaveBeenCalledTimes(1);
    expect(executor.upsertPreset).toHaveBeenCalledWith(manifest.presets[0], "2026-07-19.2");
  });

  it("syncs on first run when nothing is stored yet", async () => {
    const manifest = manifestWith("2026-07-19.1");
    const executor = fakeSyncExecutor(null);
    const result = await syncCatalog(fakeSyncStore(executor), manifest);
    expect(result.synced).toBe(true);
    expect(executor.upsertSource).toHaveBeenCalledTimes(1);
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
