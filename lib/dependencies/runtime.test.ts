import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { runDependencyCronCoordinator, type DependencyCronCoordinatorDeps } from "./runtime";

const NOW = new Date("2026-07-19T15:00:30.000Z");

function fakeDeps(overrides: Partial<DependencyCronCoordinatorDeps> = {}): DependencyCronCoordinatorDeps {
  return {
    leases: { acquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    runs: { start: vi.fn().mockResolvedValue(true), complete: vi.fn().mockResolvedValue(undefined), fail: vi.fn().mockResolvedValue(undefined) },
    syncCatalog: vi.fn().mockResolvedValue({ synced: false }),
    loadDefaultRecipients: vi.fn().mockResolvedValue(["ops@example.com"]),
    poll: vi.fn().mockResolvedValue({ sourcesDue: 1, polled: 1, notModified: 0, failed: 0 }),
    deliverOutbox: vi.fn().mockResolvedValue({ claimed: 0, sent: 0, failed: 0, dead: 0, lostClaims: 0 }),
    now: () => NOW,
    createId: (() => {
      let n = 0;
      return () => `id-${n++}`;
    })(),
    ...overrides,
  };
}

describe("runDependencyCronCoordinator", () => {
  it("returns lease-held without starting a run when the lease is unavailable", async () => {
    const deps = fakeDeps({ leases: { acquire: vi.fn().mockResolvedValue(false), release: vi.fn() } });
    const result = await runDependencyCronCoordinator(deps);
    expect(result).toEqual({ status: "lease-held" });
    expect(deps.runs.start).not.toHaveBeenCalled();
  });

  it("returns duplicate and does no work when this minute already has a run", async () => {
    const deps = fakeDeps({ runs: { start: vi.fn().mockResolvedValue(false), complete: vi.fn(), fail: vi.fn() } });
    const result = await runDependencyCronCoordinator(deps);
    expect(result).toEqual({ status: "duplicate", runId: "id-1" });
    expect(deps.syncCatalog).not.toHaveBeenCalled();
    expect(deps.poll).not.toHaveBeenCalled();
  });

  it("syncs the catalog, loads recipients, polls, and drains the outbox in order on a completed run", async () => {
    const callOrder: string[] = [];
    const deps = fakeDeps({
      syncCatalog: vi.fn(async () => { callOrder.push("sync"); return { synced: true }; }),
      loadDefaultRecipients: vi.fn(async () => { callOrder.push("recipients"); return ["ops@example.com"]; }),
      poll: vi.fn(async (recipients: string[]) => { callOrder.push(`poll:${recipients.join(",")}`); return { sourcesDue: 3, polled: 2, notModified: 1, failed: 0 }; }),
      deliverOutbox: vi.fn(async () => { callOrder.push("deliver"); return { claimed: 1, sent: 1, failed: 0, dead: 0, lostClaims: 0 }; }),
    });

    const result = await runDependencyCronCoordinator(deps);

    expect(callOrder).toEqual(["sync", "recipients", "poll:ops@example.com", "deliver"]);
    expect(result).toMatchObject({
      status: "completed",
      runId: "id-1",
      catalogSynced: true,
      sourcesDue: 3,
      polled: 2,
      notModified: 1,
      failed: 0,
    });
    expect(deps.runs.complete).toHaveBeenCalledWith("id-1", NOW, { sourcesDue: 3, polled: 2, notModified: 1, failed: 0 });
    expect(deps.leases.release).toHaveBeenCalledTimes(1);
  });

  it("acquires and releases the lease named dependency-check with a 90 second duration", async () => {
    const deps = fakeDeps();
    await runDependencyCronCoordinator(deps);
    expect(deps.leases.acquire).toHaveBeenCalledWith("dependency-check", "id-0", 90_000);
    expect(deps.leases.release).toHaveBeenCalledWith("dependency-check", "id-0");
  });

  it("records a failed run and still releases the lease when polling throws", async () => {
    const deps = fakeDeps({ poll: vi.fn().mockRejectedValue(new Error("feed exploded")) });
    const result = await runDependencyCronCoordinator(deps);
    expect(result).toEqual({ status: "failed", runId: "id-1", error: "feed exploded" });
    expect(deps.runs.fail).toHaveBeenCalledWith("id-1", NOW, "feed exploded");
    expect(deps.leases.release).toHaveBeenCalledTimes(1);
  });

  it("sanitizes newlines out of a failure message before recording it", async () => {
    const deps = fakeDeps({ poll: vi.fn().mockRejectedValue(new Error("line one\nline two\ttabbed")) });
    const result = await runDependencyCronCoordinator(deps);
    expect(result).toMatchObject({ status: "failed", error: "line one line two tabbed" });
  });
});

describe("runDependencyCron wiring", () => {
  it("passes the loaded manifest into catalog sync, gating on the stored version inside syncCatalog", async () => {
    vi.resetModules();
    const syncCatalog = vi.fn().mockResolvedValue({ synced: false, catalogVersion: "2026-07-19.2" });
    const pollDueSources = vi.fn().mockResolvedValue({ sourcesDue: 0, polled: 0, notModified: 0, failed: 0 });
    const deliverPendingNotifications = vi.fn().mockResolvedValue({ claimed: 0, sent: 0, failed: 0, dead: 0, lostClaims: 0 });
    const loadAcceptedConfig = vi.fn().mockResolvedValue({ config: { settings: { defaultRecipients: ["ops@example.com"] } } });

    vi.doMock("@/lib/db/client", () => ({ db: {} }));
    vi.doMock("@/lib/api/config-mutation", () => ({ loadAcceptedConfig }));
    vi.doMock("@/lib/notifications/delivery", () => ({ deliverPendingNotifications }));
    vi.doMock("@/lib/notifications/provider", () => ({ createResendSender: () => ({ send: vi.fn() }) }));
    vi.doMock("@/lib/scheduler/runtime", () => ({ queryExecutor: { query: vi.fn().mockResolvedValue([{ id: "run-1" }]) } }));
    vi.doMock("@/lib/scheduler/sql", () => ({ createSqlLeaseStore: () => ({ acquire: vi.fn().mockResolvedValue(true), release: vi.fn() }) }));
    vi.doMock("./catalog-sync", () => ({ syncCatalog, createSqlCatalogSyncStore: () => ({}) }));
    vi.doMock("./poller", () => ({ pollDueSources }));
    vi.doMock("./persist", () => ({ createSqlPersistStore: () => ({}), persistSnapshot: vi.fn() }));

    const { runDependencyCron } = await import("./runtime");
    const { loadCatalogManifest } = await import("./manifest");
    const result = await runDependencyCron();

    expect(syncCatalog).toHaveBeenCalledWith(expect.anything(), loadCatalogManifest());
    expect(result.status).toBe("completed");
    vi.doUnmock("@/lib/db/client");
    vi.doUnmock("@/lib/api/config-mutation");
    vi.doUnmock("@/lib/notifications/delivery");
    vi.doUnmock("@/lib/notifications/provider");
    vi.doUnmock("@/lib/scheduler/runtime");
    vi.doUnmock("@/lib/scheduler/sql");
    vi.doUnmock("./catalog-sync");
    vi.doUnmock("./poller");
    vi.doUnmock("./persist");
    vi.resetModules();
  });
});
