import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import type { SqlExecutor } from "@/lib/notifications/sql"
import {
  CLAIM_DUE_SOURCES_SQL,
  createDueSourceStore,
  type DependencyCronCoordinatorDeps,
  runDependencyCronCoordinator,
} from "./runtime"

const NOW = new Date("2026-07-19T15:00:30.000Z")

function fakeDeps(
  overrides: Partial<DependencyCronCoordinatorDeps> = {}
): DependencyCronCoordinatorDeps {
  return {
    leases: {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    },
    runs: {
      start: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    },
    releaseId: "dpl_test",
    syncCatalog: vi.fn().mockResolvedValue({ synced: false }),
    loadDefaultRecipients: vi.fn().mockResolvedValue(["ops@example.com"]),
    poll: vi.fn().mockResolvedValue({
      sourcesDue: 1,
      polled: 1,
      notModified: 0,
      failed: 0,
    }),
    reconcileOutbox: vi.fn().mockResolvedValue(0),
    deliverOutbox: vi.fn().mockResolvedValue({
      claimed: 0,
      sent: 0,
      failed: 0,
      dead: 0,
      lostClaims: 0,
    }),
    now: () => NOW,
    createId: (() => {
      let n = 0
      return () => `id-${n++}`
    })(),
    ...overrides,
  }
}

describe("runDependencyCronCoordinator", () => {
  it("returns lease-held without starting a run when the lease is unavailable", async () => {
    const deps = fakeDeps({
      leases: { acquire: vi.fn().mockResolvedValue(false), release: vi.fn() },
    })
    const result = await runDependencyCronCoordinator(deps)
    expect(result).toEqual({ status: "lease-held" })
    expect(deps.runs.start).not.toHaveBeenCalled()
  })

  it("returns duplicate and does no work when this minute already has a run", async () => {
    const deps = fakeDeps({
      runs: {
        start: vi.fn().mockResolvedValue(false),
        complete: vi.fn(),
        fail: vi.fn(),
      },
    })
    const result = await runDependencyCronCoordinator(deps)
    expect(result).toEqual({ status: "duplicate", runId: "id-1" })
    expect(deps.syncCatalog).not.toHaveBeenCalled()
    expect(deps.poll).not.toHaveBeenCalled()
  })

  it("syncs the catalog, loads recipients, polls, reconciles stale claims, and drains the outbox in order on a completed run", async () => {
    const callOrder: string[] = []
    const deps = fakeDeps({
      syncCatalog: vi.fn(async () => {
        callOrder.push("sync")
        return { synced: true }
      }),
      loadDefaultRecipients: vi.fn(async () => {
        callOrder.push("recipients")
        return ["ops@example.com"]
      }),
      poll: vi.fn(async (recipients: string[]) => {
        callOrder.push(`poll:${recipients.join(",")}`)
        return { sourcesDue: 3, polled: 2, notModified: 1, failed: 0 }
      }),
      reconcileOutbox: vi.fn(async () => {
        callOrder.push("reconcile")
        return 2
      }),
      deliverOutbox: vi.fn(async () => {
        callOrder.push("deliver")
        return { claimed: 1, sent: 1, failed: 0, dead: 0, lostClaims: 0 }
      }),
    })

    const result = await runDependencyCronCoordinator(deps)

    expect(callOrder).toEqual([
      "sync",
      "recipients",
      "poll:ops@example.com",
      "reconcile",
      "deliver",
    ])
    expect(result).toMatchObject({
      status: "completed",
      runId: "id-1",
      catalogSynced: true,
      sourcesDue: 3,
      polled: 2,
      notModified: 1,
      failed: 0,
      staleClaims: 2,
    })
    expect(deps.runs.start).toHaveBeenCalledWith(
      expect.objectContaining({ releaseId: "dpl_test" })
    )
    expect(deps.runs.complete).toHaveBeenCalledWith("id-1", NOW, {
      sourcesDue: 3,
      polled: 2,
      notModified: 1,
      failed: 0,
    })
    expect(deps.leases.release).toHaveBeenCalledTimes(1)
  })

  it("reconciles stale outbox claims before draining so the dependency cron self-heals its own stuck sends", async () => {
    const deps = fakeDeps({ reconcileOutbox: vi.fn().mockResolvedValue(3) })
    const result = await runDependencyCronCoordinator(deps)
    expect(deps.reconcileOutbox).toHaveBeenCalledWith(NOW)
    expect(deps.reconcileOutbox).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ status: "completed", staleClaims: 3 })
  })

  it("acquires and releases the lease named dependency-check with a 90 second duration", async () => {
    const deps = fakeDeps()
    await runDependencyCronCoordinator(deps)
    expect(deps.leases.acquire).toHaveBeenCalledWith(
      "dependency-check",
      "id-0",
      90_000
    )
    expect(deps.leases.release).toHaveBeenCalledWith("dependency-check", "id-0")
  })

  it("records a failed run and still releases the lease when polling throws", async () => {
    const deps = fakeDeps({
      poll: vi.fn().mockRejectedValue(new Error("feed exploded")),
    })
    const result = await runDependencyCronCoordinator(deps)
    expect(result).toEqual({
      status: "failed",
      runId: "id-1",
      error: "feed exploded",
    })
    expect(deps.runs.fail).toHaveBeenCalledWith("id-1", NOW, "feed exploded")
    expect(deps.leases.release).toHaveBeenCalledTimes(1)
  })

  it("sanitizes newlines out of a failure message before recording it", async () => {
    const deps = fakeDeps({
      poll: vi.fn().mockRejectedValue(new Error("line one\nline two\ttabbed")),
    })
    const result = await runDependencyCronCoordinator(deps)
    expect(result).toMatchObject({
      status: "failed",
      error: "line one line two tabbed",
    })
  })
})

describe("createDueSourceStore", () => {
  it("selects due sources under a skip-locked lock and advances next_poll_at in the same statement", () => {
    expect(CLAIM_DUE_SOURCES_SQL).toMatch(/for update of ds skip locked/i)
    expect(CLAIM_DUE_SOURCES_SQL).toMatch(
      /update dependency_sources[\s\S]*set next_poll_at = \$2[\s\S]*returning/i
    )
    // Only enabled sources with at least one installed, non-removed dependency
    // are due, and next_poll_at is the claim floor advanced to $2.
    expect(CLAIM_DUE_SOURCES_SQL).toMatch(/ds\.enabled = true/i)
    expect(CLAIM_DUE_SOURCES_SQL).toMatch(/d\.removed_at is null/i)
    expect(CLAIM_DUE_SOURCES_SQL).toMatch(
      /next_poll_at is null or ds\.next_poll_at <= \$1/i
    )
  })

  it("claims with a near-future floor and enriches each row's cadence from the manifest", async () => {
    const claimed = new Date("2026-07-19T15:30:00.000Z")
    const query = vi.fn(async () => [
      {
        id: "openai",
        provider_name: "OpenAI",
        adapter: "statuspage_v2",
        current_url: "https://status.openai.com/api/v2/summary.json",
        incidents_url: null,
        status_page_url: "https://status.openai.com",
        allowed_hosts: ["status.openai.com"],
        config: { foo: "bar" },
        etag: "etag-1",
        last_modified: "Sat, 19 Jul 2026 00:00:00 GMT",
        consecutive_failures: 0,
        last_success_at: new Date("2026-07-19T14:59:00.000Z"),
      },
    ])
    const store = createDueSourceStore({ query } as unknown as SqlExecutor)

    const rows = await store.listDueSources(claimed)

    expect(query).toHaveBeenCalledWith(CLAIM_DUE_SOURCES_SQL, [
      claimed,
      new Date("2026-07-19T15:31:00.000Z"),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: "openai",
      provider: "OpenAI",
      adapter: "statuspage_v2",
      currentUrl: "https://status.openai.com/api/v2/summary.json",
      allowedHosts: ["status.openai.com"],
      config: { foo: "bar" },
      etag: "etag-1",
      lastModified: "Sat, 19 Jul 2026 00:00:00 GMT",
      operationalPollSeconds: 120,
      activePollSeconds: 60,
      staleAfterSeconds: 600,
    })
  })

  it("drops a claimed source that is not in the shipped manifest rather than guessing a cadence", async () => {
    const query = vi.fn(async () => [
      {
        id: "not-in-manifest",
        provider_name: "Ghost",
        adapter: "statuspage_v2",
        current_url: "https://example.com/summary.json",
        incidents_url: null,
        status_page_url: "https://example.com",
        allowed_hosts: ["example.com"],
        config: {},
        etag: null,
        last_modified: null,
        consecutive_failures: 0,
        last_success_at: null,
      },
    ])
    const store = createDueSourceStore({ query } as unknown as SqlExecutor)
    const rows = await store.listDueSources(
      new Date("2026-07-19T15:30:00.000Z")
    )
    expect(rows).toEqual([])
  })
})

describe("runDependencyCron wiring", () => {
  it("passes the loaded manifest into catalog sync, gating on the stored version inside syncCatalog", async () => {
    vi.resetModules()
    vi.stubEnv("PULSE_RELEASE_ID", "dpl_test")
    const syncCatalog = vi
      .fn()
      .mockResolvedValue({ synced: false, catalogVersion: "2026-07-19.2" })
    const pollDueSources = vi.fn().mockResolvedValue({
      sourcesDue: 0,
      polled: 0,
      notModified: 0,
      failed: 0,
    })
    const deliverPendingNotifications = vi.fn().mockResolvedValue({
      claimed: 0,
      sent: 0,
      failed: 0,
      dead: 0,
      lostClaims: 0,
    })
    const requireAcceptedConfig = vi.fn().mockResolvedValue({
      config: { settings: { defaultRecipients: ["ops@example.com"] } },
    })

    vi.doMock("@/lib/db/client", () => ({ db: {} }))
    vi.doMock("@/lib/api/config-mutation", () => ({ requireAcceptedConfig }))
    vi.doMock("@/lib/notifications/delivery", () => ({
      deliverPendingNotifications,
    }))
    vi.doMock("@/lib/notifications/provider", () => ({
      createResendSender: () => ({ send: vi.fn() }),
    }))
    vi.doMock("@/lib/scheduler/runtime", () => ({
      queryExecutor: { query: vi.fn().mockResolvedValue([{ id: "run-1" }]) },
    }))
    vi.doMock("@/lib/scheduler/sql", () => ({
      createSqlLeaseStore: () => ({
        acquire: vi.fn().mockResolvedValue(true),
        release: vi.fn(),
      }),
    }))
    vi.doMock("./catalog-sync", () => ({
      syncCatalog,
      createSqlCatalogSyncStore: () => ({}),
    }))
    vi.doMock("./poller", () => ({ pollDueSources }))
    vi.doMock("./persist", () => ({
      createSqlPersistStore: () => ({}),
      persistSnapshot: vi.fn(),
    }))

    const { runDependencyCron } = await import("./runtime")
    const { loadCatalogManifest } = await import("./manifest")
    const result = await runDependencyCron()

    expect(syncCatalog).toHaveBeenCalledWith(
      expect.anything(),
      loadCatalogManifest()
    )
    expect(result.status).toBe("completed")
    vi.doUnmock("@/lib/db/client")
    vi.doUnmock("@/lib/api/config-mutation")
    vi.doUnmock("@/lib/notifications/delivery")
    vi.doUnmock("@/lib/notifications/provider")
    vi.doUnmock("@/lib/scheduler/runtime")
    vi.doUnmock("@/lib/scheduler/sql")
    vi.doUnmock("./catalog-sync")
    vi.doUnmock("./poller")
    vi.doUnmock("./persist")
    vi.unstubAllEnvs()
    vi.resetModules()
  })
})
