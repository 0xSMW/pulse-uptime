import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("./queries", () => ({
  getDependencyDetail: vi.fn(),
  listCatalog: vi.fn(),
  listDependenciesForDashboard: vi.fn(),
}));

import * as queries from "./queries";
import {
  DependencyApiError,
  getDependencyDetail,
  installDependency,
  listCatalog,
  listDependencies,
  patchDependency,
  recoverInstalledDependency,
  refreshDependency,
  removeDependency,
  type DependenciesStore,
  type DependencyPresetRow,
  type DependencyStateSnapshot,
} from "./service";

const NOW = new Date("2026-07-19T12:00:00.000Z");
const DETAIL = { id: "dep-1", catalogId: "vercel_runtime", state: "OPERATIONAL" } as unknown as ReturnType<typeof queries.getDependencyDetail>;

function fakeStore(overrides: Partial<DependenciesStore> = {}): DependenciesStore {
  return {
    loadPreset: vi.fn(),
    loadRecentStateForCatalogScope: vi.fn().mockResolvedValue(null),
    insertDependency: vi.fn().mockResolvedValue(true),
    touchSourceNextPoll: vi.fn(),
    loadSourceIdForDependency: vi.fn(),
    removeDependency: vi.fn(),
    patchNotifications: vi.fn(),
    ...overrides,
  };
}

function preset(overrides: Partial<DependencyPresetRow> = {}): DependencyPresetRow {
  return { id: "vercel_runtime", sourceId: "vercel", enabled: true, validatedAt: NOW, scope: null, ...overrides };
}

beforeEach(() => {
  vi.mocked(queries.getDependencyDetail).mockReset().mockResolvedValue(DETAIL as never);
  vi.mocked(queries.listCatalog).mockReset();
  vi.mocked(queries.listDependenciesForDashboard).mockReset();
});

describe("installDependency validation matrix", () => {
  it("rejects an unknown preset with PRESET_NOT_FOUND", async () => {
    const store = fakeStore({ loadPreset: vi.fn().mockResolvedValue(null) });
    await expect(installDependency({ presetId: "nope" }, { store, now: () => NOW }))
      .rejects.toMatchObject({ code: "PRESET_NOT_FOUND" });
  });

  it("rejects a disabled preset with PRESET_UNAVAILABLE", async () => {
    const store = fakeStore({ loadPreset: vi.fn().mockResolvedValue(preset({ enabled: false })) });
    await expect(installDependency({ presetId: "vercel_runtime" }, { store, now: () => NOW }))
      .rejects.toMatchObject({ code: "PRESET_UNAVAILABLE" });
  });

  it("rejects a preset that has never passed catalog validation with PRESET_UNAVAILABLE", async () => {
    const store = fakeStore({ loadPreset: vi.fn().mockResolvedValue(preset({ validatedAt: null })) });
    await expect(installDependency({ presetId: "vercel_runtime" }, { store, now: () => NOW }))
      .rejects.toMatchObject({ code: "PRESET_UNAVAILABLE" });
  });

  it("rejects a scopeId for a preset with no scope contract", async () => {
    const store = fakeStore({ loadPreset: vi.fn().mockResolvedValue(preset({ scope: null })) });
    await expect(installDependency({ presetId: "vercel_runtime", scopeId: "us-east-1" }, { store, now: () => NOW }))
      .rejects.toMatchObject({ code: "INVALID_SCOPE" });
  });

  it("requires a scopeId for a required_options preset", async () => {
    const store = fakeStore({
      loadPreset: vi.fn().mockResolvedValue(preset({
        scope: { kind: "required_options", options: [{ id: "us-east-1", label: "AWS us-east-1" }] },
      })),
    });
    await expect(installDependency({ presetId: "neon_database" }, { store, now: () => NOW }))
      .rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
  });

  it("rejects a scopeId outside the required_options catalog list", async () => {
    const store = fakeStore({
      loadPreset: vi.fn().mockResolvedValue(preset({
        scope: { kind: "required_options", options: [{ id: "us-east-1", label: "AWS us-east-1" }] },
      })),
    });
    await expect(installDependency({ presetId: "neon_database", scopeId: "eu-west-2" }, { store, now: () => NOW }))
      .rejects.toMatchObject({ code: "INVALID_SCOPE" });
  });

  it("accepts a scopeId that matches a required_options entry", async () => {
    const store = fakeStore({
      loadPreset: vi.fn().mockResolvedValue(preset({
        scope: { kind: "required_options", options: [{ id: "us-east-1", label: "AWS us-east-1" }] },
      })),
    });
    await installDependency({ presetId: "neon_database", scopeId: "us-east-1" }, { store, now: () => NOW, newId: () => "id" });
    expect(store.insertDependency).toHaveBeenCalledWith(expect.objectContaining({
      dependency: expect.objectContaining({ scopeId: "us-east-1" }),
    }));
  });

  it("requires a scopeId for a discovered_children scope marked required", async () => {
    const store = fakeStore({
      loadPreset: vi.fn().mockResolvedValue(preset({
        scope: { kind: "discovered_children", groupId: "group-1", required: true },
      })),
    });
    await expect(installDependency({ presetId: "supabase_database" }, { store, now: () => NOW }))
      .rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
  });

  it("accepts any non-empty scopeId for a discovered_children scope (discovery not yet wired in this phase)", async () => {
    const store = fakeStore({
      loadPreset: vi.fn().mockResolvedValue(preset({
        scope: { kind: "discovered_children", groupId: "group-1", required: true },
      })),
    });
    await installDependency({ presetId: "supabase_database", scopeId: "us-region" }, { store, now: () => NOW, newId: () => "id" });
    expect(store.insertDependency).toHaveBeenCalledWith(expect.objectContaining({
      dependency: expect.objectContaining({ scopeId: "us-region" }),
    }));
  });
});

describe("installDependency ten-minute snapshot rule", () => {
  it("seeds UNKNOWN with checking=true when no fresh snapshot exists", async () => {
    const store = fakeStore({
      loadPreset: vi.fn().mockResolvedValue(preset()),
      loadRecentStateForCatalogScope: vi.fn().mockResolvedValue(null),
    });
    await installDependency({ presetId: "vercel_runtime" }, { store, now: () => NOW, newId: () => "id" });
    expect(store.insertDependency).toHaveBeenCalledWith(expect.objectContaining({
      state: { state: "UNKNOWN", checking: true, observedAt: NOW, providerUpdatedAt: null },
    }));
  });

  it("reuses a fresh (< 10 minutes old) prior observation instead of UNKNOWN", async () => {
    const snapshot: DependencyStateSnapshot = {
      state: "DEGRADED",
      checking: false,
      observedAt: new Date(NOW.getTime() - 5 * 60_000),
      providerUpdatedAt: new Date(NOW.getTime() - 6 * 60_000),
    };
    const store = fakeStore({
      loadPreset: vi.fn().mockResolvedValue(preset()),
      loadRecentStateForCatalogScope: vi.fn().mockResolvedValue(snapshot),
    });
    await installDependency({ presetId: "vercel_runtime" }, { store, now: () => NOW, newId: () => "id" });
    expect(store.loadRecentStateForCatalogScope).toHaveBeenCalledWith("vercel_runtime", null, new Date(NOW.getTime() - 10 * 60_000));
    expect(store.insertDependency).toHaveBeenCalledWith(expect.objectContaining({ state: snapshot }));
  });
});

describe("installDependency duplicates and defaults", () => {
  it("maps a rejected insert (partial unique index violation) to DEPENDENCY_EXISTS", async () => {
    const store = fakeStore({
      loadPreset: vi.fn().mockResolvedValue(preset()),
      insertDependency: vi.fn().mockResolvedValue(false),
    });
    await expect(installDependency({ presetId: "vercel_runtime" }, { store, now: () => NOW }))
      .rejects.toMatchObject({ code: "DEPENDENCY_EXISTS" });
  });

  it("defaults notificationsEnabled to true and honors an explicit false", async () => {
    const store = fakeStore({ loadPreset: vi.fn().mockResolvedValue(preset()) });
    await installDependency({ presetId: "vercel_runtime" }, { store, now: () => NOW, newId: () => "id" });
    expect(store.insertDependency).toHaveBeenCalledWith(expect.objectContaining({
      dependency: expect.objectContaining({ notificationsEnabled: true }),
    }));

    await installDependency({ presetId: "vercel_runtime", notificationsEnabled: false }, { store, now: () => NOW, newId: () => "id" });
    expect(store.insertDependency).toHaveBeenCalledWith(expect.objectContaining({
      dependency: expect.objectContaining({ notificationsEnabled: false }),
    }));
  });

  it("pins the dependency's own id to a supplied dependencyId (idempotency crash recovery)", async () => {
    const store = fakeStore({ loadPreset: vi.fn().mockResolvedValue(preset()) });
    await installDependency({ presetId: "vercel_runtime" }, { store, now: () => NOW, dependencyId: "op-123" });
    expect(store.insertDependency).toHaveBeenCalledWith(expect.objectContaining({
      dependency: expect.objectContaining({ id: "op-123" }),
    }));
    expect(queries.getDependencyDetail).toHaveBeenCalledWith("op-123");
  });

  it("returns the freshly built detail projection, not a bespoke shape", async () => {
    const store = fakeStore({ loadPreset: vi.fn().mockResolvedValue(preset()) });
    const result = await installDependency({ presetId: "vercel_runtime" }, { store, now: () => NOW, newId: () => "id" });
    expect(result).toBe(DETAIL);
  });
});

describe("recoverInstalledDependency", () => {
  it("looks the dependency up by the pinned id, no content comparison", async () => {
    await recoverInstalledDependency("op-123");
    expect(queries.getDependencyDetail).toHaveBeenCalledWith("op-123");
  });
});

describe("read wrappers", () => {
  it("listDependencies delegates to the dashboard query", async () => {
    vi.mocked(queries.listDependenciesForDashboard).mockResolvedValue([{ id: "dep-1" }] as never);
    await expect(listDependencies()).resolves.toEqual([{ id: "dep-1" }]);
  });

  it("listCatalog delegates to the catalog query", async () => {
    vi.mocked(queries.listCatalog).mockResolvedValue([{ category: "hosting", presets: [] }] as never);
    await expect(listCatalog()).resolves.toEqual([{ category: "hosting", presets: [] }]);
  });

  it("getDependencyDetail throws DEPENDENCY_NOT_FOUND when the query finds nothing", async () => {
    vi.mocked(queries.getDependencyDetail).mockResolvedValue(null);
    await expect(getDependencyDetail("missing")).rejects.toMatchObject({ code: "DEPENDENCY_NOT_FOUND" });
  });

  it("getDependencyDetail returns the row when found", async () => {
    await expect(getDependencyDetail("dep-1")).resolves.toBe(DETAIL);
  });
});

describe("patchDependency", () => {
  it("rejects unknown fields (notificationsEnabled only)", async () => {
    const store = fakeStore();
    await expect(patchDependency("dep-1", { url: "https://evil.example" }, { store })).rejects.toBeInstanceOf(Error);
    expect(store.patchNotifications).not.toHaveBeenCalled();
  });

  it("throws DEPENDENCY_NOT_FOUND when no active dependency matches", async () => {
    const store = fakeStore({ patchNotifications: vi.fn().mockResolvedValue(false) });
    await expect(patchDependency("dep-1", { notificationsEnabled: false }, { store }))
      .rejects.toMatchObject({ code: "DEPENDENCY_NOT_FOUND" });
  });

  it("patches and returns the refreshed detail", async () => {
    const store = fakeStore({ patchNotifications: vi.fn().mockResolvedValue(true) });
    await expect(patchDependency("dep-1", { notificationsEnabled: false }, { store })).resolves.toBe(DETAIL);
    expect(store.patchNotifications).toHaveBeenCalledWith("dep-1", false);
  });
});

describe("removeDependency (soft remove)", () => {
  it("throws DEPENDENCY_NOT_FOUND when no active dependency matches", async () => {
    const store = fakeStore({ removeDependency: vi.fn().mockResolvedValue(false) });
    await expect(removeDependency("dep-1", { store, now: () => NOW })).rejects.toMatchObject({ code: "DEPENDENCY_NOT_FOUND" });
  });

  it("delegates the close-interval semantics to the store and reports removed", async () => {
    const store = fakeStore({ removeDependency: vi.fn().mockResolvedValue(true) });
    await expect(removeDependency("dep-1", { store, now: () => NOW })).resolves.toEqual({ id: "dep-1", removed: true });
    expect(store.removeDependency).toHaveBeenCalledWith("dep-1", NOW);
  });
});

describe("refreshDependency", () => {
  it("throws DEPENDENCY_NOT_FOUND when the dependency has no source (removed or missing)", async () => {
    const store = fakeStore({ loadSourceIdForDependency: vi.fn().mockResolvedValue(null) });
    await expect(refreshDependency("dep-1", { store, now: () => NOW })).rejects.toMatchObject({ code: "DEPENDENCY_NOT_FOUND" });
    expect(store.touchSourceNextPoll).not.toHaveBeenCalled();
  });

  it("sets the source's next_poll_at to now and returns a refreshing ack", async () => {
    const store = fakeStore({ loadSourceIdForDependency: vi.fn().mockResolvedValue("vercel") });
    await expect(refreshDependency("dep-1", { store, now: () => NOW })).resolves.toEqual({ id: "dep-1", refreshing: true });
    expect(store.touchSourceNextPoll).toHaveBeenCalledWith("vercel", NOW);
  });
});

describe("DependencyApiError", () => {
  it("carries a stable name and optional details", () => {
    const error = new DependencyApiError("SCOPE_REQUIRED", "scope required", { presetId: "neon_database" });
    expect(error.name).toBe("DependencyApiError");
    expect(error.details).toEqual({ presetId: "neon_database" });
  });
});
