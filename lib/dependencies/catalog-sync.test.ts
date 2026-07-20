import { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseTransaction } from "@/lib/db/client";
import { dependencyState, dependencyStateIntervals } from "@/lib/db/schema";

import type { CatalogManifest } from "./manifest";
import type { DependencyPresetManifest, DependencySourceManifest } from "./manifest";
import {
  flipDependenciesToUnknownSql,
  presetUpsertPlan,
  sourceUpsertPlan,
  syncCatalog,
  reconcileCatalog,
  SOURCE_DROPPED_FROM_MANIFEST_ERROR,
  type CatalogSyncExecutor,
  type CatalogSyncStore,
  type CatalogReconcileExecutor,
  type CatalogReconcileStore,
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

interface FakeReconcileState {
  sources: Array<{ id: string; adapter: string; currentUrl: string }>;
  presetsBySource: Record<string, Array<{ id: string; selector: unknown; scope: unknown; enabled?: boolean }>>;
  installedBySource: Record<string, number>;
}

function fakeReconcile(state: FakeReconcileState) {
  const recordSourceValidation = vi.fn(async () => undefined);
  const recordPresetValidationOk = vi.fn(async () => undefined);
  const reEnablePreset = vi.fn(async () => undefined);
  const disablePreset = vi.fn(async () => undefined);
  const flipDependenciesToUnknown = vi.fn(async (catalogId: string) => state.installedBySource[catalogId] ?? 0);
  const events: string[] = [];

  const executor: CatalogReconcileExecutor = {
    loadPresetsForSource: async (sourceId) =>
      (state.presetsBySource[sourceId] ?? []).map((preset) => ({ enabled: true, ...preset })) as never,
    recordSourceValidation,
    recordPresetValidationOk,
    reEnablePreset,
    disablePreset,
    flipDependenciesToUnknown,
  };
  const store: CatalogReconcileStore = {
    loadEnabledSources: async () => state.sources,
    transaction: async (work) => {
      events.push("transaction");
      return work(executor);
    },
  };
  return { store, executor, events, recordSourceValidation, recordPresetValidationOk, reEnablePreset, disablePreset, flipDependenciesToUnknown };
}

describe("reconcileCatalog", () => {
  it("disables only the preset whose selector IDs are missing from the fetched directory", async () => {
    const state: FakeReconcileState = {
      sources: [{ id: "vercel", adapter: "statuspage_v2", currentUrl: "https://www.vercel-status.com/api/v2/summary.json" }],
      presetsBySource: {
        vercel: [
          { id: "vercel_runtime", selector: { kind: "component_ids", aggregation: "worst_of", ids: ["kgcsn9c73xzf"] }, scope: null },
          { id: "vercel_deployments", selector: { kind: "component_ids", aggregation: "worst_of", ids: ["renamed-id"] }, scope: null },
        ],
      },
      installedBySource: { vercel_deployments: 2 },
    };
    const { store, disablePreset, recordPresetValidationOk, flipDependenciesToUnknown } = fakeReconcile(state);
    const fetchSourceComponents = vi.fn(async () => ({ componentIds: new Set(["kgcsn9c73xzf"]) }));

    const summary = await reconcileCatalog({
      store,
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
    const state: FakeReconcileState = {
      sources: [{ id: "vercel", adapter: "statuspage_v2", currentUrl: "https://www.vercel-status.com/api/v2/summary.json" }],
      presetsBySource: {
        vercel: [{ id: "vercel_deployments", selector: { kind: "component_ids", aggregation: "worst_of", ids: ["missing"] }, scope: null }],
      },
      installedBySource: { vercel_deployments: 3 },
    };
    const { store } = fakeReconcile(state);
    const summary = await reconcileCatalog({
      store,
      fetchSourceComponents: vi.fn(async () => ({ componentIds: new Set<string>() })),
    });

    expect(summary.unknownDependencies).toBe(3);
    expect(summary.disabledPresets).toEqual(["vercel_deployments"]);
  });

  it("records a feed error without disabling any preset when the source cannot be fetched", async () => {
    const state: FakeReconcileState = {
      sources: [{ id: "vercel", adapter: "statuspage_v2", currentUrl: "https://www.vercel-status.com/api/v2/summary.json" }],
      presetsBySource: {
        vercel: [{ id: "vercel_runtime", selector: { kind: "component_ids", aggregation: "worst_of", ids: ["kgcsn9c73xzf"] }, scope: null }],
      },
      installedBySource: {},
    };
    const { store, recordSourceValidation, disablePreset } = fakeReconcile(state);

    const summary = await reconcileCatalog({
      store,
      fetchSourceComponents: vi.fn(async () => null),
    });

    expect(recordSourceValidation).toHaveBeenCalledWith("vercel", expect.any(Date), "FEED_UNREACHABLE");
    expect(disablePreset).not.toHaveBeenCalled();
    expect(summary.disabledPresets).toEqual([]);
    expect(summary.checkedSources).toBe(1);
  });

  it("keeps a required_options preset enabled when a single region container drops but the selector's core id is present (F-B3)", async () => {
    const state: FakeReconcileState = {
      sources: [{ id: "neon", adapter: "statusio_public", currentUrl: "https://neonstatus.com/api" }],
      presetsBySource: {
        neon: [{
          id: "neon_db",
          selector: { kind: "statusio_component_container", componentId: "neon-core", container: { required: true } },
          scope: { kind: "required_options", options: [{ id: "us-east", label: "US East" }, { id: "eu-west", label: "EU West" }] },
        }],
      },
      installedBySource: { neon_db: 4 },
    };
    const { store, disablePreset, recordPresetValidationOk, flipDependenciesToUnknown } = fakeReconcile(state);

    // The feed still exposes the core component and one region, but the other
    // region dropped. The preset must not be disabled and no install flips.
    const summary = await reconcileCatalog({
      store,
      fetchSourceComponents: vi.fn(async () => ({ componentIds: new Set(["neon-core", "us-east"]) })),
    });

    expect(disablePreset).not.toHaveBeenCalled();
    expect(flipDependenciesToUnknown).not.toHaveBeenCalled();
    expect(recordPresetValidationOk).toHaveBeenCalledWith("neon_db", expect.any(Date));
    expect(summary.disabledPresets).toEqual([]);
    expect(summary.validatedPresets).toBe(1);
  });

  it("still disables a required_options preset when the selector's core id is missing (F-B3)", async () => {
    const state: FakeReconcileState = {
      sources: [{ id: "neon", adapter: "statusio_public", currentUrl: "https://neonstatus.com/api" }],
      presetsBySource: {
        neon: [{
          id: "neon_db",
          selector: { kind: "statusio_component_container", componentId: "neon-core", container: { required: true } },
          scope: { kind: "required_options", options: [{ id: "us-east", label: "US East" }] },
        }],
      },
      installedBySource: { neon_db: 2 },
    };
    const { store, disablePreset, flipDependenciesToUnknown } = fakeReconcile(state);

    const summary = await reconcileCatalog({
      store,
      fetchSourceComponents: vi.fn(async () => ({ componentIds: new Set(["us-east"]) })),
    });

    expect(disablePreset).toHaveBeenCalledWith("neon_db", expect.any(Date), expect.stringContaining("neon-core"));
    expect(flipDependenciesToUnknown).toHaveBeenCalledWith("neon_db", expect.any(Date));
    expect(summary.disabledPresets).toEqual(["neon_db"]);
  });

  it("re-enables a drift-disabled preset once its upstream id returns to the feed (F-B4)", async () => {
    const state: FakeReconcileState = {
      sources: [{ id: "vercel", adapter: "statuspage_v2", currentUrl: "https://www.vercel-status.com/api/v2/summary.json" }],
      presetsBySource: {
        vercel: [{
          id: "vercel_runtime",
          selector: { kind: "component_ids", aggregation: "worst_of", ids: ["kgcsn9c73xzf"] },
          scope: null,
          enabled: false,
        }],
      },
      installedBySource: {},
    };
    const { store, reEnablePreset, recordPresetValidationOk, disablePreset } = fakeReconcile(state);

    const summary = await reconcileCatalog({
      store,
      fetchSourceComponents: vi.fn(async () => ({ componentIds: new Set(["kgcsn9c73xzf"]) })),
    });

    expect(reEnablePreset).toHaveBeenCalledWith("vercel_runtime", expect.any(Date));
    expect(recordPresetValidationOk).not.toHaveBeenCalled();
    expect(disablePreset).not.toHaveBeenCalled();
    expect(summary.validatedPresets).toBe(1);
    expect(summary.disabledPresets).toEqual([]);
  });

  it("leaves a drift-disabled preset disabled and does not re-flip its installs when its id is still missing (F-B4)", async () => {
    const state: FakeReconcileState = {
      sources: [{ id: "vercel", adapter: "statuspage_v2", currentUrl: "https://www.vercel-status.com/api/v2/summary.json" }],
      presetsBySource: {
        vercel: [{
          id: "vercel_runtime",
          selector: { kind: "component_ids", aggregation: "worst_of", ids: ["still-missing"] },
          scope: null,
          enabled: false,
        }],
      },
      installedBySource: { vercel_runtime: 5 },
    };
    const { store, reEnablePreset, disablePreset, flipDependenciesToUnknown } = fakeReconcile(state);

    const summary = await reconcileCatalog({
      store,
      fetchSourceComponents: vi.fn(async () => ({ componentIds: new Set<string>() })),
    });

    expect(reEnablePreset).not.toHaveBeenCalled();
    expect(disablePreset).not.toHaveBeenCalled();
    expect(flipDependenciesToUnknown).not.toHaveBeenCalled();
    expect(summary.disabledPresets).toEqual([]);
    expect(summary.validatedPresets).toBe(0);
  });

  it("fetches every source's directory before opening any write transaction (F-B5)", async () => {
    const state: FakeReconcileState = {
      sources: [
        { id: "vercel", adapter: "statuspage_v2", currentUrl: "https://www.vercel-status.com/api/v2/summary.json" },
        { id: "neon", adapter: "statusio_public", currentUrl: "https://neonstatus.com/api" },
      ],
      presetsBySource: {},
      installedBySource: {},
    };
    const { store, events } = fakeReconcile(state);
    const fetchSourceComponents = vi.fn(async (source: { id: string }) => {
      events.push(`fetch:${source.id}`);
      return { componentIds: new Set<string>() };
    });

    await reconcileCatalog({ store, fetchSourceComponents });

    expect(events).toEqual(["fetch:vercel", "fetch:neon", "transaction", "transaction"]);
  });
});

describe("sourceUpsertPlan (F-B2)", () => {
  function manifestSource(overrides: Partial<DependencySourceManifest> = {}): DependencySourceManifest {
    return {
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
      ...overrides,
    };
  }

  it("inserts a fresh source enabled and sets no cache validators", () => {
    const plan = sourceUpsertPlan(manifestSource(), "2026-07-19.2");
    expect(plan.insert).toMatchObject({ id: "vercel", providerName: "Vercel", enabled: true, catalogVersion: "2026-07-19.2" });
    expect(plan.insert).not.toHaveProperty("etag");
    expect(plan.insert).not.toHaveProperty("nextPollAt");
  });

  it("clears etag, lastModified, and nextPollAt on the conflict update so a version bump forces a fresh unconditional fetch against the new url", () => {
    const plan = sourceUpsertPlan(manifestSource({ currentUrl: "https://www.vercel-status.com/api/v2/status.json" }), "2026-07-19.3");
    expect(plan.update).toMatchObject({
      currentUrl: "https://www.vercel-status.com/api/v2/status.json",
      catalogVersion: "2026-07-19.3",
      enabled: true,
      etag: null,
      lastModified: null,
      nextPollAt: null,
    });
  });
});

function recordingTx(installed: Array<{ id: string; state: string }>) {
  const updates: Array<{ table: unknown; set: Record<string, unknown> }> = [];
  const inserts: Array<{ table: unknown; rows: unknown }> = [];
  const selectChain: Record<string, unknown> = {
    from: () => selectChain,
    innerJoin: () => selectChain,
    where: async () => installed,
  };
  const tx = {
    select: () => selectChain,
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => { updates.push({ table, set }); },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (rows: unknown) => { inserts.push({ table, rows }); },
    }),
  };
  return { tx: tx as unknown as DatabaseTransaction, updates, inserts };
}

describe("flipDependenciesToUnknownSql (F-B1)", () => {
  const observedAt = new Date("2026-07-19T00:00:00.000Z");

  it("advances stateStartedAt and closes the open interval with a greatest() expression for a transitioning install", async () => {
    const { tx, updates, inserts } = recordingTx([{ id: "dep-1", state: "OPERATIONAL" }]);

    const count = await flipDependenciesToUnknownSql(tx, "vercel_runtime", observedAt);

    expect(count).toBe(1);
    const stateStartedAtUpdate = updates.find((u) => u.table === dependencyState && "stateStartedAt" in u.set);
    expect(stateStartedAtUpdate?.set.stateStartedAt).toEqual(observedAt);

    const intervalClose = updates.find((u) => u.table === dependencyStateIntervals);
    // endedAt must be a greatest(observedAt, started_at) SQL expression, never
    // a bare Date that a slightly-behind observedAt could push before started_at.
    expect(intervalClose?.set.endedAt).toBeInstanceOf(SQL);
    expect(intervalClose?.set.endedAt).not.toBeInstanceOf(Date);

    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.table).toBe(dependencyStateIntervals);
  });

  it("writes no stateStartedAt, no interval close, and no new interval for an install already UNKNOWN (change-only)", async () => {
    const { tx, updates, inserts } = recordingTx([{ id: "dep-1", state: "UNKNOWN" }]);

    const count = await flipDependenciesToUnknownSql(tx, "vercel_runtime", observedAt);

    expect(count).toBe(1);
    expect(updates.find((u) => "stateStartedAt" in u.set)).toBeUndefined();
    expect(updates.find((u) => u.table === dependencyStateIntervals)).toBeUndefined();
    expect(inserts).toHaveLength(0);
  });
});
