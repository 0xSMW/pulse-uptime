import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db: { transaction: vi.fn(), update: vi.fn() } }));
vi.mock("./queries", () => ({
  getDependencyDetail: vi.fn(),
  listCatalog: vi.fn(),
  listDependenciesForDashboard: vi.fn(),
}));

import { SQL } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { dependencies, dependencySources, dependencyStateIntervals } from "@/lib/db/schema";
import * as queries from "./queries";
import {
  DependencyApiError,
  DependencyInstallConflictError,
  databaseDependenciesStore,
  requireDependencyDetail,
  addDependency,
  listCatalog,
  listDependencies,
  patchDependency,
  scheduleDependencyPoll,
  removeDependency,
  type DependenciesStore,
  type DependencyPresetRow,
  type DependencyStateSnapshot,
} from "./service";

const NOW = new Date("2026-07-19T12:00:00.000Z");
const DETAIL = { id: "dep-1", presetId: "vercel_runtime", state: "OPERATIONAL" } as unknown as ReturnType<typeof queries.getDependencyDetail>;

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
  return { id: "vercel_runtime", sourceId: "vercel", enabled: true, validatedAt: NOW, validationError: null, scope: null, ...overrides };
}

beforeEach(() => {
  vi.mocked(queries.getDependencyDetail).mockReset().mockResolvedValue(DETAIL as never);
  vi.mocked(queries.listCatalog).mockReset();
  vi.mocked(queries.listDependenciesForDashboard).mockReset();
});

describe("addDependency validation matrix", () => {
  it("rejects an unknown preset with PRESET_NOT_FOUND", async () => {
    const store = fakeStore({ loadPreset: vi.fn().mockResolvedValue(null) });
    await expect(addDependency({ presetId: "nope" }, { store, now: () => NOW }))
      .rejects.toMatchObject({ code: "PRESET_NOT_FOUND" });
  });

  it("rejects a disabled preset with PRESET_UNAVAILABLE", async () => {
    const store = fakeStore({ loadPreset: vi.fn().mockResolvedValue(preset({ enabled: false })) });
    await expect(addDependency({ presetId: "vercel_runtime" }, { store, now: () => NOW }))
      .rejects.toMatchObject({ code: "PRESET_UNAVAILABLE" });
  });

  it("accepts a preset that has never passed catalog validation (validatedAt and validationError both null)", async () => {
    const store = fakeStore({
      loadPreset: vi.fn().mockResolvedValue(preset({ validatedAt: null, validationError: null })),
    });
    await addDependency({ presetId: "vercel_runtime" }, { store, now: () => NOW, newId: () => "id" });
    expect(store.insertDependency).toHaveBeenCalled();
  });

  it("rejects a preset with a recorded validation error with PRESET_UNAVAILABLE, even when enabled", async () => {
    const store = fakeStore({
      loadPreset: vi.fn().mockResolvedValue(preset({ enabled: true, validationError: "Missing upstream component ids: renamed-id" })),
    });
    await expect(addDependency({ presetId: "vercel_runtime" }, { store, now: () => NOW }))
      .rejects.toMatchObject({ code: "PRESET_UNAVAILABLE" });
  });

  it("rejects a scopeId for a preset with no scope contract", async () => {
    const store = fakeStore({ loadPreset: vi.fn().mockResolvedValue(preset({ scope: null })) });
    await expect(addDependency({ presetId: "vercel_runtime", scopeId: "us-east-1" }, { store, now: () => NOW }))
      .rejects.toMatchObject({ code: "INVALID_SCOPE" });
  });

  it("requires a scopeId for a required_options preset", async () => {
    const store = fakeStore({
      loadPreset: vi.fn().mockResolvedValue(preset({
        scope: { kind: "required_options", options: [{ id: "us-east-1", label: "AWS us-east-1" }] },
      })),
    });
    await expect(addDependency({ presetId: "neon_database" }, { store, now: () => NOW }))
      .rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
  });

  it("rejects a scopeId outside the required_options catalog list", async () => {
    const store = fakeStore({
      loadPreset: vi.fn().mockResolvedValue(preset({
        scope: { kind: "required_options", options: [{ id: "us-east-1", label: "AWS us-east-1" }] },
      })),
    });
    await expect(addDependency({ presetId: "neon_database", scopeId: "eu-west-2" }, { store, now: () => NOW }))
      .rejects.toMatchObject({ code: "INVALID_SCOPE" });
  });

  it("accepts a scopeId that matches a required_options entry", async () => {
    const store = fakeStore({
      loadPreset: vi.fn().mockResolvedValue(preset({
        scope: { kind: "required_options", options: [{ id: "us-east-1", label: "AWS us-east-1" }] },
      })),
    });
    await addDependency({ presetId: "neon_database", scopeId: "us-east-1" }, { store, now: () => NOW, newId: () => "id" });
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
    await expect(addDependency({ presetId: "supabase_database" }, { store, now: () => NOW }))
      .rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
  });

  it("accepts any non-empty scopeId for a discovered_children scope (discovery not yet wired in this phase)", async () => {
    const store = fakeStore({
      loadPreset: vi.fn().mockResolvedValue(preset({
        scope: { kind: "discovered_children", groupId: "group-1", required: true },
      })),
    });
    await addDependency({ presetId: "supabase_database", scopeId: "us-region" }, { store, now: () => NOW, newId: () => "id" });
    expect(store.insertDependency).toHaveBeenCalledWith(expect.objectContaining({
      dependency: expect.objectContaining({ scopeId: "us-region" }),
    }));
  });
});

describe("addDependency ten-minute snapshot rule", () => {
  it("seeds UNKNOWN with pendingFirstPoll=true when no fresh snapshot exists", async () => {
    const store = fakeStore({
      loadPreset: vi.fn().mockResolvedValue(preset()),
      loadRecentStateForCatalogScope: vi.fn().mockResolvedValue(null),
    });
    await addDependency({ presetId: "vercel_runtime" }, { store, now: () => NOW, newId: () => "id" });
    expect(store.insertDependency).toHaveBeenCalledWith(expect.objectContaining({
      state: { state: "UNKNOWN", pendingFirstPoll: true, observedAt: NOW, providerUpdatedAt: null },
    }));
  });

  it("reuses a fresh (< 10 minutes old) prior observation instead of UNKNOWN", async () => {
    const snapshot: DependencyStateSnapshot = {
      state: "DEGRADED",
      pendingFirstPoll: false,
      observedAt: new Date(NOW.getTime() - 5 * 60_000),
      providerUpdatedAt: new Date(NOW.getTime() - 6 * 60_000),
    };
    const store = fakeStore({
      loadPreset: vi.fn().mockResolvedValue(preset()),
      loadRecentStateForCatalogScope: vi.fn().mockResolvedValue(snapshot),
    });
    await addDependency({ presetId: "vercel_runtime" }, { store, now: () => NOW, newId: () => "id" });
    expect(store.loadRecentStateForCatalogScope).toHaveBeenCalledWith("vercel_runtime", null, new Date(NOW.getTime() - 10 * 60_000));
    expect(store.insertDependency).toHaveBeenCalledWith(expect.objectContaining({ state: snapshot }));
  });
});

describe("addDependency duplicates and defaults", () => {
  it("maps a rejected insert (partial unique index violation) to DEPENDENCY_EXISTS", async () => {
    const store = fakeStore({
      loadPreset: vi.fn().mockResolvedValue(preset()),
      insertDependency: vi.fn().mockResolvedValue(false),
    });
    await expect(addDependency({ presetId: "vercel_runtime" }, { store, now: () => NOW }))
      .rejects.toMatchObject({ code: "DEPENDENCY_EXISTS" });
  });

  it("defaults notificationsEnabled to true and honors an explicit false", async () => {
    const store = fakeStore({ loadPreset: vi.fn().mockResolvedValue(preset()) });
    await addDependency({ presetId: "vercel_runtime" }, { store, now: () => NOW, newId: () => "id" });
    expect(store.insertDependency).toHaveBeenCalledWith(expect.objectContaining({
      dependency: expect.objectContaining({ notificationsEnabled: true }),
    }));

    await addDependency({ presetId: "vercel_runtime", notificationsEnabled: false }, { store, now: () => NOW, newId: () => "id" });
    expect(store.insertDependency).toHaveBeenCalledWith(expect.objectContaining({
      dependency: expect.objectContaining({ notificationsEnabled: false }),
    }));
  });

  it("pins the dependency's own id to a supplied dependencyId (idempotency crash recovery)", async () => {
    const store = fakeStore({ loadPreset: vi.fn().mockResolvedValue(preset()) });
    await addDependency({ presetId: "vercel_runtime" }, { store, now: () => NOW, dependencyId: "op-123" });
    expect(store.insertDependency).toHaveBeenCalledWith(expect.objectContaining({
      dependency: expect.objectContaining({ id: "op-123" }),
    }));
    expect(queries.getDependencyDetail).toHaveBeenCalledWith("op-123", db);
  });

  it("reads the detail back on the same transaction handle the insert ran on, not the pooled db", async () => {
    const store = fakeStore({ loadPreset: vi.fn().mockResolvedValue(preset()) });
    const tx = { transaction: vi.fn(), update: vi.fn() } as unknown as typeof db;
    await addDependency({ presetId: "vercel_runtime" }, { store, now: () => NOW, newId: () => "id" }, tx);
    expect(store.insertDependency).toHaveBeenCalledWith(expect.objectContaining({ handle: tx }));
    expect(queries.getDependencyDetail).toHaveBeenCalledWith("id", tx);
    expect(queries.getDependencyDetail).not.toHaveBeenCalledWith("id", db);
  });

  it("returns the freshly built detail projection, not a bespoke shape", async () => {
    const store = fakeStore({ loadPreset: vi.fn().mockResolvedValue(preset()) });
    const result = await addDependency({ presetId: "vercel_runtime" }, { store, now: () => NOW, newId: () => "id" });
    expect(result).toBe(DETAIL);
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

  it("requireDependencyDetail throws DEPENDENCY_NOT_FOUND when the query finds nothing", async () => {
    vi.mocked(queries.getDependencyDetail).mockResolvedValue(null);
    await expect(requireDependencyDetail("missing")).rejects.toMatchObject({ code: "DEPENDENCY_NOT_FOUND" });
  });

  it("requireDependencyDetail returns the row when found", async () => {
    await expect(requireDependencyDetail("dep-1")).resolves.toBe(DETAIL);
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
    expect(store.patchNotifications).toHaveBeenCalledWith("dep-1", false, db);
  });

  it("threads a caller-supplied transaction handle into both the update and the read-back", async () => {
    const store = fakeStore({ patchNotifications: vi.fn().mockResolvedValue(true) });
    const tx = { transaction: vi.fn(), update: vi.fn() } as unknown as typeof db;
    await patchDependency("dep-1", { notificationsEnabled: false }, { store }, tx);
    expect(store.patchNotifications).toHaveBeenCalledWith("dep-1", false, tx);
    expect(queries.getDependencyDetail).toHaveBeenCalledWith("dep-1", tx);
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
    expect(store.removeDependency).toHaveBeenCalledWith("dep-1", NOW, db);
  });

  it("threads a caller-supplied transaction handle into the store so the removal commits with the idempotency record", async () => {
    const store = fakeStore({ removeDependency: vi.fn().mockResolvedValue(true) });
    const tx = { transaction: vi.fn(), update: vi.fn() } as unknown as typeof db;
    await removeDependency("dep-1", { store, now: () => NOW }, tx);
    expect(store.removeDependency).toHaveBeenCalledWith("dep-1", NOW, tx);
  });
});

describe("scheduleDependencyPoll", () => {
  it("throws DEPENDENCY_NOT_FOUND when the dependency has no source (removed or missing)", async () => {
    const store = fakeStore({ loadSourceIdForDependency: vi.fn().mockResolvedValue(null) });
    await expect(scheduleDependencyPoll("dep-1", { store, now: () => NOW })).rejects.toMatchObject({ code: "DEPENDENCY_NOT_FOUND" });
    expect(store.touchSourceNextPoll).not.toHaveBeenCalled();
  });

  it("sets the source's next_poll_at to now and returns a queued ack", async () => {
    const store = fakeStore({ loadSourceIdForDependency: vi.fn().mockResolvedValue("vercel") });
    await expect(scheduleDependencyPoll("dep-1", { store, now: () => NOW })).resolves.toEqual({ id: "dep-1", queued: true });
    expect(store.touchSourceNextPoll).toHaveBeenCalledWith("vercel", NOW);
  });
});

describe("databaseDependenciesStore validator clearing (FIX D)", () => {
  it("clears the source's etag and last_modified in the same transaction that installs a dependency", async () => {
    const setCalls: Array<{ table: unknown; patch: Record<string, unknown> }> = [];
    const tx = {
      // No existing active dependency, so the duplicate pre-check passes and the insert proceeds.
      select: () => ({ from: () => ({ where: () => ({ limit: vi.fn().mockResolvedValue([]) }) }) }),
      insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }),
      update: (table: unknown) => ({
        set: (patch: Record<string, unknown>) => {
          setCalls.push({ table, patch });
          return { where: vi.fn().mockResolvedValue(undefined) };
        },
      }),
    };
    vi.mocked(db.transaction).mockImplementation((async (work: (tx: unknown) => Promise<unknown>) => work(tx)) as never);

    const inserted = await databaseDependenciesStore.insertDependency({
      dependency: { id: "dep-1", catalogId: "vercel_runtime", scopeId: null, notificationsEnabled: true, createdAt: NOW, removedAt: null },
      state: { state: "UNKNOWN", pendingFirstPoll: true, observedAt: NOW, providerUpdatedAt: null },
      intervalId: "interval-1",
      sourceId: "vercel",
      now: NOW,
    });

    expect(inserted).toBe(true);
    const sourceUpdate = setCalls.find((call) => call.table === dependencySources);
    expect(sourceUpdate?.patch).toMatchObject({ nextPollAt: NOW, etag: null, lastModified: null });
  });

  it("clears the source's etag and last_modified on a manual refresh's touchSourceNextPoll", async () => {
    const setCalls: Array<{ table: unknown; patch: Record<string, unknown> }> = [];
    vi.mocked(db.update).mockImplementation((table: unknown) => ({
      set: (patch: Record<string, unknown>) => {
        setCalls.push({ table, patch });
        return { where: vi.fn().mockResolvedValue(undefined) };
      },
    }) as never);

    await databaseDependenciesStore.touchSourceNextPoll("vercel", NOW);

    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]?.table).toBe(dependencySources);
    expect(setCalls[0]?.patch).toMatchObject({ nextPollAt: NOW, etag: null, lastModified: null });
  });
});

describe("databaseDependenciesStore insertDependency race handling", () => {
  function txMock(insertError?: { code: string }) {
    return {
      select: () => ({ from: () => ({ where: () => ({ limit: vi.fn().mockResolvedValue([]) }) }) }),
      insert: () => ({
        values: insertError ? vi.fn().mockRejectedValue(insertError) : vi.fn().mockResolvedValue(undefined),
      }),
      update: () => ({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) }),
    };
  }

  it("throws DependencyInstallConflictError when a unique violation lands on the caller's own transaction handle", async () => {
    const tx = txMock({ code: "23505" }) as unknown as typeof db;

    await expect(databaseDependenciesStore.insertDependency({
      dependency: { id: "dep-1", catalogId: "vercel_runtime", scopeId: null, notificationsEnabled: true, createdAt: NOW, removedAt: null },
      state: { state: "UNKNOWN", pendingFirstPoll: true, observedAt: NOW, providerUpdatedAt: null },
      intervalId: "interval-1",
      sourceId: "vercel",
      now: NOW,
      handle: tx,
    })).rejects.toBeInstanceOf(DependencyInstallConflictError);
  });

  it("maps a unique violation to false when no handle is given, wrapping runInsert in its own transaction", async () => {
    vi.mocked(db.transaction).mockImplementation((async (work: (tx: unknown) => Promise<unknown>) => {
      return work(txMock({ code: "23505" }));
    }) as never);

    const inserted = await databaseDependenciesStore.insertDependency({
      dependency: { id: "dep-2", catalogId: "vercel_runtime", scopeId: null, notificationsEnabled: true, createdAt: NOW, removedAt: null },
      state: { state: "UNKNOWN", pendingFirstPoll: true, observedAt: NOW, providerUpdatedAt: null },
      intervalId: "interval-2",
      sourceId: "vercel",
      now: NOW,
    });

    expect(inserted).toBe(false);
  });
});

describe("databaseDependenciesStore removeDependency (FIX D1/D2)", () => {
  function removeTxMock(matched: boolean) {
    const setCalls: Array<{ table: unknown; patch: Record<string, unknown> }> = [];
    const tx = {
      update: (table: unknown) => ({
        set: (patch: Record<string, unknown>) => {
          setCalls.push({ table, patch });
          const where = () => {
            const result = Promise.resolve(undefined) as Promise<unknown> & { returning?: () => Promise<unknown> };
            result.returning = () => Promise.resolve(matched ? [{ id: "dep-1" }] : []);
            return result;
          };
          return { where };
        },
      }),
    };
    return { tx, setCalls };
  }

  it("closes the open interval with greatest(now, started_at), not a bare now, so a slightly-behind now never aborts the transaction", async () => {
    const { tx, setCalls } = removeTxMock(true);
    const removed = await databaseDependenciesStore.removeDependency("dep-1", NOW, tx as unknown as typeof db);
    expect(removed).toBe(true);
    const intervalUpdate = setCalls.find((call) => call.table === dependencyStateIntervals);
    expect(intervalUpdate?.patch.endedAt).toBeInstanceOf(SQL);
    expect(intervalUpdate?.patch.endedAt).not.toBe(NOW);
  });

  it("runs the removal directly on a caller-supplied handle rather than opening its own transaction", async () => {
    const { tx } = removeTxMock(true);
    vi.mocked(db.transaction).mockClear();
    const removed = await databaseDependenciesStore.removeDependency("dep-1", NOW, tx as unknown as typeof db);
    expect(removed).toBe(true);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("returns false and closes no interval when no active dependency matches", async () => {
    const { tx, setCalls } = removeTxMock(false);
    const removed = await databaseDependenciesStore.removeDependency("dep-1", NOW, tx as unknown as typeof db);
    expect(removed).toBe(false);
    expect(setCalls.find((call) => call.table === dependencyStateIntervals)).toBeUndefined();
  });

  it("opens its own transaction when no handle is supplied", async () => {
    const { tx } = removeTxMock(true);
    vi.mocked(db.transaction).mockImplementation((async (work: (handle: unknown) => Promise<unknown>) => work(tx)) as never);
    const removed = await databaseDependenciesStore.removeDependency("dep-1", NOW);
    expect(removed).toBe(true);
    expect(db.transaction).toHaveBeenCalled();
  });
});

describe("databaseDependenciesStore patchNotifications (FIX D1)", () => {
  it("updates on the caller-supplied handle so the change commits with the idempotency record", async () => {
    const setCalls: Array<{ table: unknown; patch: Record<string, unknown> }> = [];
    const handle = {
      update: (table: unknown) => ({
        set: (patch: Record<string, unknown>) => {
          setCalls.push({ table, patch });
          return { where: () => ({ returning: vi.fn().mockResolvedValue([{ id: "dep-1" }]) }) };
        },
      }),
    };
    const patched = await databaseDependenciesStore.patchNotifications("dep-1", false, handle as unknown as typeof db);
    expect(patched).toBe(true);
    expect(setCalls[0]?.table).toBe(dependencies);
    expect(setCalls[0]?.patch).toMatchObject({ notificationsEnabled: false });
  });

  it("falls back to the pooled db when no handle is supplied", async () => {
    vi.mocked(db.update).mockImplementation(((table: unknown) => ({
      set: () => ({ where: () => ({ returning: vi.fn().mockResolvedValue(table === dependencies ? [{ id: "dep-1" }] : []) }) }),
    })) as never);
    const patched = await databaseDependenciesStore.patchNotifications("dep-1", true);
    expect(patched).toBe(true);
    expect(db.update).toHaveBeenCalledWith(dependencies);
  });
});

describe("DependencyApiError", () => {
  it("carries a stable name and optional details", () => {
    const error = new DependencyApiError("SCOPE_REQUIRED", "scope required", { presetId: "neon_database" });
    expect(error.name).toBe("DependencyApiError");
    expect(error.details).toEqual({ presetId: "neon_database" });
  });
});
