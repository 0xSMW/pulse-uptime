import { SQL } from "drizzle-orm"
import { describe, expect, it, vi } from "vitest"

import type { DatabaseTransaction } from "@/lib/db/client"
import { dependencyState, dependencyStateIntervals } from "@/lib/db/schema"
import {
  type CatalogReconcileExecutor,
  type CatalogReconcileStore,
  type CatalogSyncExecutor,
  type CatalogSyncStore,
  flipDependenciesToUnknownSql,
  type ObservedScopeOption,
  observedScopeOptionsForPreset,
  planDiscoveredScopeSync,
  presetUpsertPlan,
  reconcileCatalog,
  SOURCE_DROPPED_FROM_MANIFEST_ERROR,
  type StoredPresetDefinition,
  sourceUpsertPlan,
  syncCatalog,
} from "./catalog-sync"
import type {
  CatalogManifest,
  DependencyPresetManifest,
  DependencySourceManifest,
} from "./manifest"
import {
  type CatalogComponentDirectory,
  catalogDirectoryFromComponentIds,
} from "./types"

function directoryOf(...ids: string[]): CatalogComponentDirectory {
  return catalogDirectoryFromComponentIds(ids)
}

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
        selector: {
          kind: "component_ids",
          aggregation: "worst_of",
          ids: ["kgcsn9c73xzf"],
        },
        scope: null,
        sourceScopeNote: null,
        enabled: true,
      },
    ],
  }
}

function fakeSyncExecutor(
  storedVersion: string | null,
  options: {
    enabledSourceIds?: string[]
    presetIdsBySource?: Record<string, string[]>
  } = {}
): CatalogSyncExecutor & {
  lock: ReturnType<typeof vi.fn>
  upsertSource: ReturnType<typeof vi.fn>
  upsertPreset: ReturnType<typeof vi.fn>
  disableSource: ReturnType<typeof vi.fn>
  disablePreset: ReturnType<typeof vi.fn>
  flipDependenciesToUnknown: ReturnType<typeof vi.fn>
} {
  const presetIdsBySource = options.presetIdsBySource ?? {}
  return {
    lock: vi.fn(async () => undefined),
    getStoredCatalogVersion: vi.fn(async () => storedVersion),
    upsertSource: vi.fn(async () => undefined),
    upsertPreset: vi.fn(async () => undefined),
    listEnabledSourceIds: vi.fn(async () => options.enabledSourceIds ?? []),
    disableSource: vi.fn(async () => undefined),
    listEnabledPresetIdsForSource: vi.fn(
      async (sourceId: string) => presetIdsBySource[sourceId] ?? []
    ),
    disablePreset: vi.fn(async () => undefined),
    flipDependenciesToUnknown: vi.fn(async () => 0),
  }
}

function fakeSyncStore(executor: CatalogSyncExecutor): CatalogSyncStore {
  return { transaction: (work) => work(executor) }
}

describe("syncCatalog", () => {
  it("skips the upsert when the stored catalog version already matches the manifest", async () => {
    const manifest = manifestWith("2026-07-19.1")
    const executor = fakeSyncExecutor("2026-07-19.1")
    const result = await syncCatalog(fakeSyncStore(executor), manifest)

    expect(result).toEqual({
      synced: false,
      catalogVersion: "2026-07-19.1",
      droppedSources: [],
    })
    expect(executor.lock).toHaveBeenCalledTimes(1)
    expect(executor.upsertSource).not.toHaveBeenCalled()
    expect(executor.upsertPreset).not.toHaveBeenCalled()
    expect(executor.listEnabledSourceIds).not.toHaveBeenCalled()
  })

  it("upserts every source and preset when the manifest version differs from the stored version", async () => {
    const manifest = manifestWith("2026-07-19.2")
    const executor = fakeSyncExecutor("2026-07-19.1", {
      enabledSourceIds: ["vercel"],
    })
    const result = await syncCatalog(fakeSyncStore(executor), manifest)

    expect(result).toEqual({
      synced: true,
      catalogVersion: "2026-07-19.2",
      droppedSources: [],
    })
    expect(executor.upsertSource).toHaveBeenCalledTimes(1)
    expect(executor.upsertSource).toHaveBeenCalledWith(
      manifest.sources[0],
      "2026-07-19.2"
    )
    expect(executor.upsertPreset).toHaveBeenCalledTimes(1)
    expect(executor.upsertPreset).toHaveBeenCalledWith(
      manifest.presets[0],
      "2026-07-19.2",
      "component"
    )
    expect(executor.disableSource).not.toHaveBeenCalled()
  })

  it("disables a source dropped from the manifest, records a validation error on its presets, and flips its dependencies to UNKNOWN", async () => {
    const manifest = manifestWith("2026-07-19.2")
    const observedAt = new Date("2026-07-19T00:00:00.000Z")
    const executor = fakeSyncExecutor("2026-07-19.1", {
      enabledSourceIds: ["vercel", "retired-provider"],
      presetIdsBySource: { "retired-provider": ["retired_runtime"] },
    })

    const result = await syncCatalog(
      fakeSyncStore(executor),
      manifest,
      () => observedAt
    )

    expect(result.droppedSources).toEqual(["retired-provider"])
    expect(executor.disableSource).toHaveBeenCalledTimes(1)
    expect(executor.disableSource).toHaveBeenCalledWith(
      "retired-provider",
      observedAt,
      SOURCE_DROPPED_FROM_MANIFEST_ERROR
    )
    expect(executor.disablePreset).toHaveBeenCalledTimes(1)
    expect(executor.disablePreset).toHaveBeenCalledWith(
      "retired_runtime",
      observedAt,
      SOURCE_DROPPED_FROM_MANIFEST_ERROR
    )
    expect(executor.flipDependenciesToUnknown).toHaveBeenCalledTimes(1)
    expect(executor.flipDependenciesToUnknown).toHaveBeenCalledWith(
      "retired_runtime",
      observedAt
    )
  })

  it("does not treat any source as dropped when the stored catalog version already matches", async () => {
    const manifest = manifestWith("2026-07-19.1")
    const executor = fakeSyncExecutor("2026-07-19.1", {
      enabledSourceIds: ["vercel", "retired-provider"],
    })
    const result = await syncCatalog(fakeSyncStore(executor), manifest)

    expect(result).toEqual({
      synced: false,
      catalogVersion: "2026-07-19.1",
      droppedSources: [],
    })
    expect(executor.disableSource).not.toHaveBeenCalled()
  })

  it("syncs on first run when nothing is stored yet", async () => {
    const manifest = manifestWith("2026-07-19.1")
    const executor = fakeSyncExecutor(null)
    const result = await syncCatalog(fakeSyncStore(executor), manifest)
    expect(result.synced).toBe(true)
    expect(executor.upsertSource).toHaveBeenCalledTimes(1)
  })
})

function manifestPreset(
  overrides: Partial<DependencyPresetManifest> = {}
): DependencyPresetManifest {
  return {
    id: "vercel_runtime",
    sourceId: "vercel",
    name: "Vercel Runtime",
    category: "hosting",
    description: "Vercel Functions, CDN, routing middleware, and DNS.",
    selector: {
      kind: "component_ids",
      aggregation: "worst_of",
      ids: ["kgcsn9c73xzf"],
    },
    scope: null,
    sourceScopeNote: null,
    enabled: true,
    ...overrides,
  }
}

function storedDefinition(
  overrides: Partial<StoredPresetDefinition> = {}
): StoredPresetDefinition {
  return {
    sourceId: "vercel",
    selector: {
      kind: "component_ids",
      aggregation: "worst_of",
      ids: ["kgcsn9c73xzf"],
    },
    scope: null,
    ...overrides,
  }
}

describe("presetUpsertPlan", () => {
  it("starts a brand new preset (no stored row) unvalidated", () => {
    const plan = presetUpsertPlan(null, manifestPreset(), "2026-07-19.2")
    expect(plan.insert).toMatchObject({
      validatedAt: null,
      validationError: null,
    })
    expect(plan.update).toEqual(plan.insert)
  })

  it("preserves validation state across a version bump when the source, selector, and scope are unchanged", () => {
    const plan = presetUpsertPlan(
      storedDefinition(),
      manifestPreset({ name: "Vercel Runtime (renamed)" }),
      "2026-07-19.2"
    )
    expect(plan.update).not.toHaveProperty("validatedAt")
    expect(plan.update).not.toHaveProperty("validationError")
    expect(plan.update).toMatchObject({
      displayName: "Vercel Runtime (renamed)",
      catalogVersion: "2026-07-19.2",
    })
  })

  it("leaves the stored enabled flag untouched across a version bump when the definition is unchanged, so a drift-disabled preset is not re-enabled", () => {
    const plan = presetUpsertPlan(
      storedDefinition(),
      manifestPreset({ enabled: true }),
      "2026-07-19.2"
    )
    expect(plan.update).not.toHaveProperty("enabled")
  })

  it("re-enables and resets validation state when the definition materially changed", () => {
    const plan = presetUpsertPlan(
      storedDefinition({ sourceId: "aws" }),
      manifestPreset({ enabled: true }),
      "2026-07-19.2"
    )
    expect(plan.update).toMatchObject({
      enabled: true,
      validatedAt: null,
      validationError: null,
    })
  })

  it("starts a brand new preset enabled", () => {
    const plan = presetUpsertPlan(
      null,
      manifestPreset({ enabled: true }),
      "2026-07-19.2"
    )
    expect(plan.insert).toMatchObject({ enabled: true })
  })

  it("preserves validation state when the scope's option key order differs (jsonb round-trip reordering, not a real change)", () => {
    const stored = storedDefinition({
      selector: {
        ids: ["kgcsn9c73xzf"],
        kind: "component_ids",
        aggregation: "worst_of",
      } as never,
    })
    const plan = presetUpsertPlan(stored, manifestPreset(), "2026-07-19.2")
    expect(plan.update).not.toHaveProperty("validatedAt")
  })

  it("resets validation state when the selector's component ids changed", () => {
    const plan = presetUpsertPlan(
      storedDefinition(),
      manifestPreset({
        selector: {
          kind: "component_ids",
          aggregation: "worst_of",
          ids: ["a-different-id"],
        },
      }),
      "2026-07-19.2"
    )
    expect(plan.update).toMatchObject({
      validatedAt: null,
      validationError: null,
    })
  })

  it("resets validation state when the source changed", () => {
    const plan = presetUpsertPlan(
      storedDefinition({ sourceId: "aws" }),
      manifestPreset(),
      "2026-07-19.2"
    )
    expect(plan.update).toMatchObject({
      validatedAt: null,
      validationError: null,
    })
  })

  it("resets validation state when the scope changed", () => {
    const plan = presetUpsertPlan(
      storedDefinition({ scope: null }),
      manifestPreset({
        scope: {
          kind: "required_options",
          options: [{ id: "us-east-1", label: "AWS us-east-1" }],
        },
      }),
      "2026-07-19.2"
    )
    expect(plan.update).toMatchObject({
      validatedAt: null,
      validationError: null,
    })
  })
})

interface FakeReconcileState {
  sources: Array<{ id: string; adapter: string; currentUrl: string }>
  presetsBySource: Record<
    string,
    Array<{ id: string; selector: unknown; scope: unknown; enabled?: boolean }>
  >
  installedBySource: Record<string, number>
}

function fakeReconcile(state: FakeReconcileState) {
  const recordSourceValidation = vi.fn(async () => undefined)
  const recordPresetValidationOk = vi.fn(async () => undefined)
  const reEnablePreset = vi.fn(async () => undefined)
  const disablePreset = vi.fn(async () => undefined)
  const flipDependenciesToUnknown = vi.fn(
    async (catalogId: string) => state.installedBySource[catalogId] ?? 0
  )
  const syncDiscoveredScopeOptions = vi.fn(async () => undefined)
  const events: string[] = []

  const executor: CatalogReconcileExecutor = {
    loadPresetsForSource: async (sourceId) =>
      (state.presetsBySource[sourceId] ?? []).map((preset) => ({
        enabled: true,
        ...preset,
      })) as never,
    recordSourceValidation,
    recordPresetValidationOk,
    reEnablePreset,
    disablePreset,
    flipDependenciesToUnknown,
    syncDiscoveredScopeOptions,
  }
  const store: CatalogReconcileStore = {
    loadEnabledSources: async () => state.sources,
    transaction: async (work) => {
      events.push("transaction")
      return work(executor)
    },
  }
  return {
    store,
    executor,
    events,
    recordSourceValidation,
    recordPresetValidationOk,
    reEnablePreset,
    disablePreset,
    flipDependenciesToUnknown,
    syncDiscoveredScopeOptions,
  }
}

describe("reconcileCatalog", () => {
  it("disables only the preset whose selector IDs are missing from the fetched directory", async () => {
    const state: FakeReconcileState = {
      sources: [
        {
          id: "vercel",
          adapter: "statuspage_v2",
          currentUrl: "https://www.vercel-status.com/api/v2/summary.json",
        },
      ],
      presetsBySource: {
        vercel: [
          {
            id: "vercel_runtime",
            selector: {
              kind: "component_ids",
              aggregation: "worst_of",
              ids: ["kgcsn9c73xzf"],
            },
            scope: null,
          },
          {
            id: "vercel_deployments",
            selector: {
              kind: "component_ids",
              aggregation: "worst_of",
              ids: ["renamed-id"],
            },
            scope: null,
          },
        ],
      },
      installedBySource: { vercel_deployments: 2 },
    }
    const {
      store,
      disablePreset,
      recordPresetValidationOk,
      flipDependenciesToUnknown,
    } = fakeReconcile(state)
    const fetchCatalogDirectory = vi.fn(async () => directoryOf("kgcsn9c73xzf"))

    const summary = await reconcileCatalog({
      store,
      fetchCatalogDirectory,
      now: () => new Date("2026-07-19T00:00:00.000Z"),
    })

    expect(summary.disabledPresets).toEqual(["vercel_deployments"])
    expect(summary.validatedPresets).toBe(1)
    expect(disablePreset).toHaveBeenCalledTimes(1)
    expect(disablePreset).toHaveBeenCalledWith(
      "vercel_deployments",
      new Date("2026-07-19T00:00:00.000Z"),
      expect.stringContaining("renamed-id")
    )
    expect(recordPresetValidationOk).toHaveBeenCalledWith(
      "vercel_runtime",
      new Date("2026-07-19T00:00:00.000Z")
    )
    expect(flipDependenciesToUnknown).toHaveBeenCalledTimes(1)
    expect(flipDependenciesToUnknown).toHaveBeenCalledWith(
      "vercel_deployments",
      new Date("2026-07-19T00:00:00.000Z")
    )
  })

  it("keeps incident-only presets enabled when the directory tracks no components", async () => {
    const state: FakeReconcileState = {
      sources: [
        {
          id: "openrouter",
          adapter: "incident_feed",
          currentUrl: "https://status.openrouter.ai/incidents.rss",
        },
      ],
      presetsBySource: {
        openrouter: [
          {
            id: "openrouter_api",
            selector: {
              kind: "component_ids",
              aggregation: "worst_of",
              ids: ["incident-feed"],
            },
            scope: null,
          },
        ],
      },
      installedBySource: { openrouter_api: 3 },
    }
    const {
      store,
      disablePreset,
      recordPresetValidationOk,
      flipDependenciesToUnknown,
    } = fakeReconcile(state)
    const incidentOnlyDirectory: CatalogComponentDirectory = {
      componentIds: new Set(),
      childrenByParent: new Map(),
      locationsByProduct: new Map(),
      complete: true,
      tracksComponents: false,
    }

    const summary = await reconcileCatalog({
      store,
      fetchCatalogDirectory: vi.fn(async () => incidentOnlyDirectory),
      now: () => new Date("2026-07-19T00:00:00.000Z"),
    })

    expect(summary.disabledPresets).toEqual([])
    expect(summary.validatedPresets).toBe(1)
    expect(disablePreset).not.toHaveBeenCalled()
    expect(flipDependenciesToUnknown).not.toHaveBeenCalled()
    expect(recordPresetValidationOk).toHaveBeenCalledWith(
      "openrouter_api",
      new Date("2026-07-19T00:00:00.000Z")
    )
  })

  it("flips a disabled preset's installed dependencies to UNKNOWN and reports the count", async () => {
    const state: FakeReconcileState = {
      sources: [
        {
          id: "vercel",
          adapter: "statuspage_v2",
          currentUrl: "https://www.vercel-status.com/api/v2/summary.json",
        },
      ],
      presetsBySource: {
        vercel: [
          {
            id: "vercel_deployments",
            selector: {
              kind: "component_ids",
              aggregation: "worst_of",
              ids: ["missing"],
            },
            scope: null,
          },
        ],
      },
      installedBySource: { vercel_deployments: 3 },
    }
    const { store } = fakeReconcile(state)
    const summary = await reconcileCatalog({
      store,
      fetchCatalogDirectory: vi.fn(async () => directoryOf()),
    })

    expect(summary.unknownDependencies).toBe(3)
    expect(summary.disabledPresets).toEqual(["vercel_deployments"])
  })

  it("records a feed error without disabling any preset when the source cannot be fetched", async () => {
    const state: FakeReconcileState = {
      sources: [
        {
          id: "vercel",
          adapter: "statuspage_v2",
          currentUrl: "https://www.vercel-status.com/api/v2/summary.json",
        },
      ],
      presetsBySource: {
        vercel: [
          {
            id: "vercel_runtime",
            selector: {
              kind: "component_ids",
              aggregation: "worst_of",
              ids: ["kgcsn9c73xzf"],
            },
            scope: null,
          },
        ],
      },
      installedBySource: {},
    }
    const { store, recordSourceValidation, disablePreset } =
      fakeReconcile(state)

    const summary = await reconcileCatalog({
      store,
      fetchCatalogDirectory: vi.fn(async () => null),
    })

    expect(recordSourceValidation).toHaveBeenCalledWith(
      "vercel",
      expect.any(Date),
      "FEED_UNREACHABLE"
    )
    expect(disablePreset).not.toHaveBeenCalled()
    expect(summary.disabledPresets).toEqual([])
    expect(summary.checkedSources).toBe(1)
  })

  it("keeps a required_options preset enabled when a single region container drops but the selector's core id is present (F-B3)", async () => {
    const state: FakeReconcileState = {
      sources: [
        {
          id: "neon",
          adapter: "statusio_public",
          currentUrl: "https://neonstatus.com/api",
        },
      ],
      presetsBySource: {
        neon: [
          {
            id: "neon_db",
            selector: {
              kind: "statusio_component_container",
              componentId: "neon-core",
              container: { required: true },
            },
            scope: {
              kind: "required_options",
              options: [
                { id: "us-east", label: "US East" },
                { id: "eu-west", label: "EU West" },
              ],
            },
          },
        ],
      },
      installedBySource: { neon_db: 4 },
    }
    const {
      store,
      disablePreset,
      recordPresetValidationOk,
      flipDependenciesToUnknown,
    } = fakeReconcile(state)

    // The feed still exposes the core component and one region, but the other
    // region dropped. The preset must not be disabled and no install flips.
    const summary = await reconcileCatalog({
      store,
      fetchCatalogDirectory: vi.fn(async () =>
        directoryOf("neon-core", "us-east")
      ),
    })

    expect(disablePreset).not.toHaveBeenCalled()
    expect(flipDependenciesToUnknown).not.toHaveBeenCalled()
    expect(recordPresetValidationOk).toHaveBeenCalledWith(
      "neon_db",
      expect.any(Date)
    )
    expect(summary.disabledPresets).toEqual([])
    expect(summary.validatedPresets).toBe(1)
  })

  it("still disables a required_options preset when the selector's core id is missing (F-B3)", async () => {
    const state: FakeReconcileState = {
      sources: [
        {
          id: "neon",
          adapter: "statusio_public",
          currentUrl: "https://neonstatus.com/api",
        },
      ],
      presetsBySource: {
        neon: [
          {
            id: "neon_db",
            selector: {
              kind: "statusio_component_container",
              componentId: "neon-core",
              container: { required: true },
            },
            scope: {
              kind: "required_options",
              options: [{ id: "us-east", label: "US East" }],
            },
          },
        ],
      },
      installedBySource: { neon_db: 2 },
    }
    const { store, disablePreset, flipDependenciesToUnknown } =
      fakeReconcile(state)

    const summary = await reconcileCatalog({
      store,
      fetchCatalogDirectory: vi.fn(async () => directoryOf("us-east")),
    })

    expect(disablePreset).toHaveBeenCalledWith(
      "neon_db",
      expect.any(Date),
      expect.stringContaining("neon-core")
    )
    expect(flipDependenciesToUnknown).toHaveBeenCalledWith(
      "neon_db",
      expect.any(Date)
    )
    expect(summary.disabledPresets).toEqual(["neon_db"])
  })

  it("re-enables a drift-disabled preset once its upstream id returns to the feed (F-B4)", async () => {
    const state: FakeReconcileState = {
      sources: [
        {
          id: "vercel",
          adapter: "statuspage_v2",
          currentUrl: "https://www.vercel-status.com/api/v2/summary.json",
        },
      ],
      presetsBySource: {
        vercel: [
          {
            id: "vercel_runtime",
            selector: {
              kind: "component_ids",
              aggregation: "worst_of",
              ids: ["kgcsn9c73xzf"],
            },
            scope: null,
            enabled: false,
          },
        ],
      },
      installedBySource: {},
    }
    const { store, reEnablePreset, recordPresetValidationOk, disablePreset } =
      fakeReconcile(state)

    const summary = await reconcileCatalog({
      store,
      fetchCatalogDirectory: vi.fn(async () => directoryOf("kgcsn9c73xzf")),
    })

    expect(reEnablePreset).toHaveBeenCalledWith(
      "vercel_runtime",
      expect.any(Date)
    )
    expect(recordPresetValidationOk).not.toHaveBeenCalled()
    expect(disablePreset).not.toHaveBeenCalled()
    expect(summary.validatedPresets).toBe(1)
    expect(summary.disabledPresets).toEqual([])
  })

  it("leaves a drift-disabled preset disabled and does not re-flip its installs when its id is still missing (F-B4)", async () => {
    const state: FakeReconcileState = {
      sources: [
        {
          id: "vercel",
          adapter: "statuspage_v2",
          currentUrl: "https://www.vercel-status.com/api/v2/summary.json",
        },
      ],
      presetsBySource: {
        vercel: [
          {
            id: "vercel_runtime",
            selector: {
              kind: "component_ids",
              aggregation: "worst_of",
              ids: ["still-missing"],
            },
            scope: null,
            enabled: false,
          },
        ],
      },
      installedBySource: { vercel_runtime: 5 },
    }
    const { store, reEnablePreset, disablePreset, flipDependenciesToUnknown } =
      fakeReconcile(state)

    const summary = await reconcileCatalog({
      store,
      fetchCatalogDirectory: vi.fn(async () => directoryOf()),
    })

    expect(reEnablePreset).not.toHaveBeenCalled()
    expect(disablePreset).not.toHaveBeenCalled()
    expect(flipDependenciesToUnknown).not.toHaveBeenCalled()
    expect(summary.disabledPresets).toEqual([])
    expect(summary.validatedPresets).toBe(0)
  })

  it("fetches every source's directory before opening any write transaction (F-B5)", async () => {
    const state: FakeReconcileState = {
      sources: [
        {
          id: "vercel",
          adapter: "statuspage_v2",
          currentUrl: "https://www.vercel-status.com/api/v2/summary.json",
        },
        {
          id: "neon",
          adapter: "statusio_public",
          currentUrl: "https://neonstatus.com/api",
        },
      ],
      presetsBySource: {},
      installedBySource: {},
    }
    const { store, events } = fakeReconcile(state)
    const fetchCatalogDirectory = vi.fn(
      async ({ source }: { source: { id: string } }) => {
        events.push(`fetch:${source.id}`)
        return directoryOf()
      }
    )

    await reconcileCatalog({ store, fetchCatalogDirectory })

    expect(events).toEqual([
      "fetch:vercel",
      "fetch:neon",
      "transaction",
      "transaction",
    ])
  })

  it("stops starting new source fetches once the deadline passes, leaving the rest for the next pass", async () => {
    const state: FakeReconcileState = {
      sources: Array.from({ length: 5 }, (_, index) => ({
        id: `source-${index}`,
        adapter: "statuspage_v2",
        currentUrl: `https://example.com/${index}`,
      })),
      presetsBySource: {},
      installedBySource: {},
    }
    const { store } = fakeReconcile(state)

    // Each live fetch burns 100ms of the slice. With a 200ms deadline only the
    // first two sources start before nowMs reaches it, and the loop breaks
    // before the third fetch.
    let clock = 0
    const fetched: string[] = []
    const fetchCatalogDirectory = vi.fn(
      async ({ source }: { source: { id: string } }) => {
        fetched.push(source.id)
        clock += 100
        return directoryOf()
      }
    )

    const summary = await reconcileCatalog({
      store,
      fetchCatalogDirectory,
      nowMs: () => clock,
      deadlineAtMs: 200,
    })

    expect(fetched).toEqual(["source-0", "source-1"])
    expect(fetchCatalogDirectory).toHaveBeenCalledTimes(2)
    // checkedSources reports only the sources actually processed, so the summary
    // never claims to have validated the sources left for the next pass.
    expect(summary.checkedSources).toBe(2)
  })
})

describe("sourceUpsertPlan (F-B2)", () => {
  function manifestSource(
    overrides: Partial<DependencySourceManifest> = {}
  ): DependencySourceManifest {
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
    }
  }

  it("inserts a fresh source enabled and sets no cache validators", () => {
    const plan = sourceUpsertPlan(manifestSource(), "2026-07-19.2")
    expect(plan.insert).toMatchObject({
      id: "vercel",
      providerName: "Vercel",
      enabled: true,
      catalogVersion: "2026-07-19.2",
    })
    expect(plan.insert).not.toHaveProperty("etag")
    expect(plan.insert).not.toHaveProperty("nextPollAt")
  })

  it("clears etag, lastModified, and nextPollAt on the conflict update so a version bump forces a fresh unconditional fetch against the new url", () => {
    const plan = sourceUpsertPlan(
      manifestSource({
        currentUrl: "https://www.vercel-status.com/api/v2/status.json",
      }),
      "2026-07-19.3"
    )
    expect(plan.update).toMatchObject({
      currentUrl: "https://www.vercel-status.com/api/v2/status.json",
      catalogVersion: "2026-07-19.3",
      enabled: true,
      etag: null,
      lastModified: null,
      nextPollAt: null,
    })
  })
})

function recordingTx(installed: Array<{ id: string; state: string }>) {
  const updates: Array<{ table: unknown; set: Record<string, unknown> }> = []
  const inserts: Array<{ table: unknown; rows: unknown }> = []
  const selectChain: Record<string, unknown> = {
    from: () => selectChain,
    innerJoin: () => selectChain,
    where: async () => installed,
  }
  const tx = {
    select: () => selectChain,
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ table, set })
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (rows: unknown) => {
        inserts.push({ table, rows })
      },
    }),
  }
  return { tx: tx as unknown as DatabaseTransaction, updates, inserts }
}

describe("flipDependenciesToUnknownSql (F-B1)", () => {
  const observedAt = new Date("2026-07-19T00:00:00.000Z")

  it("advances stateStartedAt and closes the open interval with a greatest() expression for a transitioning install", async () => {
    const { tx, updates, inserts } = recordingTx([
      { id: "dep-1", state: "OPERATIONAL" },
    ])

    const count = await flipDependenciesToUnknownSql(
      tx,
      "vercel_runtime",
      observedAt
    )

    expect(count).toBe(1)
    const stateStartedAtUpdate = updates.find(
      (u) => u.table === dependencyState && "stateStartedAt" in u.set
    )
    expect(stateStartedAtUpdate?.set.stateStartedAt).toEqual(observedAt)

    const intervalClose = updates.find(
      (u) => u.table === dependencyStateIntervals
    )
    // endedAt must be a greatest(observedAt, started_at) SQL expression, never
    // a bare Date that a slightly-behind observedAt could push before started_at.
    expect(intervalClose?.set.endedAt).toBeInstanceOf(SQL)
    expect(intervalClose?.set.endedAt).not.toBeInstanceOf(Date)

    expect(inserts).toHaveLength(1)
    expect(inserts[0]?.table).toBe(dependencyStateIntervals)
  })

  it("writes no stateStartedAt, no interval close, and no new interval for an install already UNKNOWN (change-only)", async () => {
    const { tx, updates, inserts } = recordingTx([
      { id: "dep-1", state: "UNKNOWN" },
    ])

    const count = await flipDependenciesToUnknownSql(
      tx,
      "vercel_runtime",
      observedAt
    )

    expect(count).toBe(1)
    expect(updates.find((u) => "stateStartedAt" in u.set)).toBeUndefined()
    expect(
      updates.find((u) => u.table === dependencyStateIntervals)
    ).toBeUndefined()
    expect(inserts).toHaveLength(0)
  })
})

describe("planDiscoveredScopeSync", () => {
  const at = new Date("2026-07-20T12:00:00.000Z")

  it("upserts every observed option as available and marks unobserved prior options unavailable", () => {
    const observed: ObservedScopeOption[] = [
      {
        scopeId: "fra1",
        label: "FRA1",
        scopeKind: "discovered_child",
        parentExternalId: "group-1",
      },
      {
        scopeId: "nyc1",
        label: "NYC1",
        scopeKind: "discovered_child",
        parentExternalId: "group-1",
      },
    ]
    const plan = planDiscoveredScopeSync(
      [{ scopeId: "fra1" }, { scopeId: "ams3" }],
      observed,
      at
    )
    expect(plan.upserts).toEqual([
      expect.objectContaining({
        scopeId: "fra1",
        available: true,
        lastSeenAt: at,
        label: "FRA1",
      }),
      expect.objectContaining({
        scopeId: "nyc1",
        available: true,
        lastSeenAt: at,
      }),
    ])
    expect(plan.unavailableScopeIds).toEqual(["ams3"])
  })

  it("marks every prior option unavailable when a complete refresh observes none", () => {
    const plan = planDiscoveredScopeSync(
      [{ scopeId: "fra1" }, { scopeId: "nyc1" }],
      [],
      at
    )
    expect(plan.upserts).toEqual([])
    expect(plan.unavailableScopeIds).toEqual(["fra1", "nyc1"])
  })
})

describe("observedScopeOptionsForPreset", () => {
  it("resolves discovered_children against childrenByParent[groupId]", () => {
    const directory: CatalogComponentDirectory = {
      componentIds: new Set(["group-1", "fra1", "nyc1"]),
      childrenByParent: new Map([
        [
          "group-1",
          [
            { id: "fra1", label: "FRA1" },
            { id: "nyc1", label: "NYC1" },
          ],
        ],
      ]),
      locationsByProduct: new Map(),
      complete: true,
      tracksComponents: true,
    }
    const observed = observedScopeOptionsForPreset(
      {
        selector: {
          kind: "component_ids",
          aggregation: "worst_of",
          ids: ["group-1"],
        },
        scope: {
          kind: "discovered_children",
          groupId: "group-1",
          required: true,
        },
      },
      directory
    )
    expect(observed).toEqual([
      expect.objectContaining({
        scopeId: "fra1",
        label: "FRA1",
        scopeKind: "discovered_child",
        parentExternalId: "group-1",
      }),
      expect.objectContaining({
        scopeId: "nyc1",
        label: "NYC1",
        scopeKind: "discovered_child",
        parentExternalId: "group-1",
      }),
    ])
  })

  it("resolves discovered_locations against locationsByProduct[productId]", () => {
    const directory: CatalogComponentDirectory = {
      componentIds: new Set(["prod-1"]),
      childrenByParent: new Map(),
      locationsByProduct: new Map([
        ["prod-1", [{ id: "us-central1", label: "us-central1" }]],
      ]),
      complete: true,
      tracksComponents: true,
    }
    const observed = observedScopeOptionsForPreset(
      {
        selector: {
          kind: "google_product",
          productId: "prod-1",
          location: { required: false },
        },
        scope: { kind: "discovered_locations", required: false },
      },
      directory
    )
    expect(observed).toEqual([
      expect.objectContaining({
        scopeId: "us-central1",
        scopeKind: "discovered_location",
        parentExternalId: "prod-1",
      }),
    ])
  })

  it("returns null for required_options and null scopes", () => {
    const directory = directoryOf("x")
    expect(
      observedScopeOptionsForPreset(
        {
          selector: {
            kind: "component_ids",
            aggregation: "worst_of",
            ids: ["x"],
          },
          scope: null,
        },
        directory
      )
    ).toBeNull()
    expect(
      observedScopeOptionsForPreset(
        {
          selector: {
            kind: "statusio_component_container",
            componentId: "x",
            container: { required: true },
          },
          scope: {
            kind: "required_options",
            options: [{ id: "r1", label: "R1" }],
          },
        },
        directory
      )
    ).toBeNull()
  })
})

describe("reconcileCatalog discovered scope materialisation", () => {
  it("syncs discovered children when a complete directory validates the preset", async () => {
    const state: FakeReconcileState = {
      sources: [
        {
          id: "digitalocean",
          adapter: "statuspage_v2",
          currentUrl: "https://status.digitalocean.com/api/v2/summary.json",
        },
      ],
      presetsBySource: {
        digitalocean: [
          {
            id: "digitalocean_droplets",
            selector: {
              kind: "component_ids",
              aggregation: "worst_of",
              ids: ["4rgs7bbljl8d"],
            },
            scope: {
              kind: "discovered_children",
              groupId: "4rgs7bbljl8d",
              required: true,
            },
          },
        ],
      },
      installedBySource: {},
    }
    const { store, syncDiscoveredScopeOptions } = fakeReconcile(state)
    const directory: CatalogComponentDirectory = {
      componentIds: new Set(["4rgs7bbljl8d", "kkg2cfkqkwj1"]),
      childrenByParent: new Map([
        ["4rgs7bbljl8d", [{ id: "kkg2cfkqkwj1", label: "FRA1" }]],
      ]),
      locationsByProduct: new Map(),
      complete: true,
      tracksComponents: true,
    }

    await reconcileCatalog({
      store,
      fetchCatalogDirectory: vi.fn(async () => directory),
      now: () => new Date("2026-07-20T12:00:00.000Z"),
    })

    expect(syncDiscoveredScopeOptions).toHaveBeenCalledWith(
      "digitalocean_droplets",
      [
        expect.objectContaining({
          scopeId: "kkg2cfkqkwj1",
          label: "FRA1",
          scopeKind: "discovered_child",
        }),
      ],
      new Date("2026-07-20T12:00:00.000Z")
    )
  })

  it("does not touch discovered scope options when the directory fetch fails", async () => {
    const state: FakeReconcileState = {
      sources: [
        {
          id: "digitalocean",
          adapter: "statuspage_v2",
          currentUrl: "https://status.digitalocean.com/api/v2/summary.json",
        },
      ],
      presetsBySource: {
        digitalocean: [
          {
            id: "digitalocean_droplets",
            selector: {
              kind: "component_ids",
              aggregation: "worst_of",
              ids: ["4rgs7bbljl8d"],
            },
            scope: {
              kind: "discovered_children",
              groupId: "4rgs7bbljl8d",
              required: true,
            },
          },
        ],
      },
      installedBySource: {},
    }
    const { store, syncDiscoveredScopeOptions, recordSourceValidation } =
      fakeReconcile(state)

    await reconcileCatalog({
      store,
      fetchCatalogDirectory: vi.fn(async () => null),
    })

    expect(recordSourceValidation).toHaveBeenCalledWith(
      "digitalocean",
      expect.any(Date),
      "FEED_UNREACHABLE"
    )
    expect(syncDiscoveredScopeOptions).not.toHaveBeenCalled()
  })

  it("does not materialise options from an incomplete directory", async () => {
    const state: FakeReconcileState = {
      sources: [
        {
          id: "digitalocean",
          adapter: "statuspage_v2",
          currentUrl: "https://status.digitalocean.com/api/v2/summary.json",
        },
      ],
      presetsBySource: {
        digitalocean: [
          {
            id: "digitalocean_droplets",
            selector: {
              kind: "component_ids",
              aggregation: "worst_of",
              ids: ["4rgs7bbljl8d"],
            },
            scope: {
              kind: "discovered_children",
              groupId: "4rgs7bbljl8d",
              required: true,
            },
          },
        ],
      },
      installedBySource: {},
    }
    const { store, syncDiscoveredScopeOptions } = fakeReconcile(state)
    const incomplete: CatalogComponentDirectory = {
      componentIds: new Set(["4rgs7bbljl8d"]),
      childrenByParent: new Map([
        ["4rgs7bbljl8d", [{ id: "partial", label: "Partial" }]],
      ]),
      locationsByProduct: new Map(),
      complete: false,
      tracksComponents: true,
    }

    await reconcileCatalog({
      store,
      fetchCatalogDirectory: vi.fn(async () => incomplete),
    })

    expect(syncDiscoveredScopeOptions).not.toHaveBeenCalled()
  })
})

describe("resolveScopeSelection", () => {
  it("maps required_options to a static selection with every option available", async () => {
    const { resolveScopeSelection } = await import("./types")
    expect(
      resolveScopeSelection(
        {
          kind: "required_options",
          options: [{ id: "us-east-1", label: "US East" }],
        },
        null
      )
    ).toEqual({
      required: true,
      allowsUnscoped: false,
      status: "static",
      options: [{ id: "us-east-1", label: "US East", available: true }],
    })
  })

  it("reports pending when discovered options have never been materialised", async () => {
    const { resolveScopeSelection } = await import("./types")
    expect(
      resolveScopeSelection(
        { kind: "discovered_children", groupId: "g1", required: true },
        null
      )
    ).toEqual({
      required: true,
      allowsUnscoped: false,
      status: "pending",
      options: [],
    })
  })

  it("reports ready when any discovered option is available", async () => {
    const { resolveScopeSelection } = await import("./types")
    expect(
      resolveScopeSelection(
        { kind: "discovered_children", groupId: "g1", required: true },
        [
          { id: "a", label: "A", available: false },
          { id: "b", label: "B", available: true },
        ]
      )?.status
    ).toBe("ready")
  })

  it("reports unavailable when every discovered option is unavailable", async () => {
    const { resolveScopeSelection } = await import("./types")
    expect(
      resolveScopeSelection({ kind: "discovered_locations", required: false }, [
        { id: "loc", label: "Loc", available: false },
      ])
    ).toMatchObject({
      required: false,
      allowsUnscoped: true,
      status: "unavailable",
    })
  })
})
