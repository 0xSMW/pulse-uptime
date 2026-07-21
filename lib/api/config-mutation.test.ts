import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/scheduler/registry-sync", () => ({
  synchronizeRegistry: vi.fn(),
}))

/** A fake DatabaseHandle whose select chain always resolves to `row`, whose insert chain resolves to undefined, and whose `.transaction` runs `run` against itself (mirroring a real handle/tx sharing one connection). */
function makeHandle(row: unknown) {
  const selectChain: Record<string, unknown> = {}
  selectChain.from = vi.fn(() => selectChain)
  selectChain.where = vi.fn(() => selectChain)
  selectChain.orderBy = vi.fn(() => selectChain)
  selectChain.limit = vi.fn(async () => [row])
  const insertChain: Record<string, unknown> = {
    values: vi.fn(async () => undefined),
  }
  const handle: Record<string, unknown> = {
    execute: vi.fn(async () => undefined),
    select: vi.fn(() => selectChain),
    insert: vi.fn(() => insertChain),
  }
  handle.transaction = vi.fn(async (run: (tx: unknown) => unknown) =>
    run(handle)
  )
  return handle
}

const { defaultHandle } = vi.hoisted(() => ({
  defaultHandle: { transaction: vi.fn() },
}))
vi.mock("@/lib/db/client", () => ({ db: defaultHandle }))

import {
  DEFAULT_MONITOR_SETTINGS,
  hashMonitoringConfig,
  type MonitoringConfig,
} from "@/lib/config"
import type { DatabaseHandle } from "@/lib/db/client"
import { synchronizeRegistry as mockSynchronizeRegistry } from "@/lib/scheduler/registry-sync"

import { mutateConfig } from "./config-mutation"

const CONFIG: MonitoringConfig = {
  schemaVersion: 2,
  configVersion: 1,
  settings: { ...DEFAULT_MONITOR_SETTINGS },
  groups: [],
  monitors: [],
}
const HASH = hashMonitoringConfig(CONFIG)
const ROW = { configJson: CONFIG, configHash: HASH }

describe("mutateConfig handle threading", () => {
  beforeEach(() => {
    vi.mocked(defaultHandle.transaction).mockReset()
    vi.mocked(mockSynchronizeRegistry).mockReset()
  })

  it("opens the transaction on the default db handle when none is given", async () => {
    const handle = makeHandle(ROW) as unknown as DatabaseHandle
    vi.mocked(defaultHandle.transaction).mockImplementation(
      async (run: (tx: unknown) => unknown) => run(handle)
    )

    const result = await mutateConfig("human:1", (config) => config)

    expect(defaultHandle.transaction).toHaveBeenCalledOnce()
    expect(result).toEqual(CONFIG)
  })

  it("opens the transaction on the given handle instead of the default db, so it joins an outer transaction as a savepoint", async () => {
    const handle = makeHandle(ROW) as unknown as DatabaseHandle

    const result = await mutateConfig("human:1", (config) => config, handle)

    expect(handle.transaction).toHaveBeenCalledOnce()
    expect(defaultHandle.transaction).not.toHaveBeenCalled()
    expect(result).toEqual(CONFIG)
  })

  it("reads the accepted snapshot through the SAME given handle, not the default pool (finding: reading via a different connection than the one holding the advisory lock could observe a different snapshot)", async () => {
    const handle = makeHandle(ROW) as unknown as DatabaseHandle

    await mutateConfig("human:1", (config) => config, handle)

    expect(handle.select).toHaveBeenCalled()
  })

  it("propagates a mutator error so the caller's transaction rolls back (no completion, no snapshot write)", async () => {
    const handle = makeHandle(ROW) as unknown as DatabaseHandle
    const failure = new Error("mutator rejected this change")

    await expect(
      mutateConfig(
        "human:1",
        () => {
          throw failure
        },
        handle
      )
    ).rejects.toThrow(failure)
  })

  it("does not call Edge Config when synchronizeRegistry fails (finding: writeEdgeConfig is not rollbackable, so it must run after every DB statement that can still abort the transaction)", async () => {
    const handle = makeHandle(ROW) as unknown as DatabaseHandle
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }))
    process.env.EDGE_CONFIG_ID = "ecfg_test"
    process.env.VERCEL_API_TOKEN = "test-token"
    vi.mocked(mockSynchronizeRegistry).mockRejectedValueOnce(
      new Error("registry sync failed")
    )

    const mutator = (config: MonitoringConfig) => ({
      ...config,
      settings: {
        ...config.settings,
        concurrency: config.settings.concurrency + 1,
      },
    })

    await expect(mutateConfig("human:1", mutator, handle)).rejects.toThrow(
      "registry sync failed"
    )
    expect(mockSynchronizeRegistry).toHaveBeenCalledOnce()
    expect(fetchSpy).not.toHaveBeenCalled()

    fetchSpy.mockRestore()
    delete process.env.EDGE_CONFIG_ID
    delete process.env.VERCEL_API_TOKEN
  })
})
