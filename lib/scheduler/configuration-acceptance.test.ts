import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/api/configuration-lock", () => ({
  lockConfiguration: vi.fn(async () => undefined),
}))
vi.mock("@/lib/scheduler/registry-sync", () => ({
  synchronizeRegistry: vi.fn(async () => undefined),
}))
vi.mock("@/lib/config/accepted-config", () => ({
  findAcceptedSnapshot: vi.fn(),
}))

const { defaultHandle } = vi.hoisted(() => ({
  defaultHandle: { transaction: vi.fn() },
}))
vi.mock("@/lib/db/client", () => ({ db: defaultHandle }))

import { lockConfiguration } from "@/lib/api/configuration-lock"
import {
  createMonitorWithDefaults,
  DEFAULT_MONITOR_SETTINGS,
  evaluateConfigurationAcceptance,
  hashMonitoringConfig,
  type MonitoringConfig,
  validateMonitoringConfig,
} from "@/lib/config"
import { findAcceptedSnapshot } from "@/lib/config/accepted-config"
import type { DatabaseHandle } from "@/lib/db/client"
import { synchronizeRegistry } from "@/lib/scheduler/registry-sync"

import { acceptDesiredConfiguration } from "./configuration-acceptance"

const NOW = new Date("2026-07-18T04:00:00.000Z")

const baseConfig = (): MonitoringConfig => ({
  schemaVersion: 2,
  configVersion: 1,
  settings: { ...DEFAULT_MONITOR_SETTINGS, defaultRecipients: [] },
  groups: [],
  monitors: [
    createMonitorWithDefaults({
      id: "site-one",
      name: "Site one",
      url: "https://example.com",
    }),
  ],
})

/**
 * Transaction fake that records the order of lock, snapshot read, insert,
 * approval consume, and registry sync so the critical-section sequence is
 * assertable without a live database.
 */
function makeTx(options: {
  previous: { config: MonitoringConfig; hash: string } | null
  approvals?: Array<{
    id: string
    targetConfigHash: string
    action: string
    expiresAt: Date
    consumedAt: Date | null
  }>
  consumeSucceeds?: boolean
}) {
  const events: string[] = []
  const inserts: unknown[] = []

  const selectChain: Record<string, unknown> = {}
  selectChain.from = vi.fn(() => selectChain)
  selectChain.where = vi.fn(() => selectChain)
  selectChain.orderBy = vi.fn(() => selectChain)
  selectChain.limit = vi.fn(async () => {
    events.push("approval-lookup")
    return options.approvals ?? []
  })

  // One update builder serves approval consume (with .returning) and
  // config_operations state updates (without). where() returns a Promise
  // with a .returning method so both await where() and await where().returning()
  // work without a plain-object thenable.
  const updateChain: Record<string, unknown> = {}
  updateChain.set = vi.fn(() => updateChain)
  updateChain.where = vi.fn(() => {
    events.push("update")
    return Object.assign(Promise.resolve(undefined), {
      returning: async () => {
        events.push("approval-consume")
        if (options.consumeSucceeds === false) {
          return []
        }
        const id = options.approvals?.[0]?.id
        return id ? [{ id }] : []
      },
    })
  })

  const insertChain: Record<string, unknown> = {
    values: vi.fn(async (value: unknown) => {
      events.push("snapshot-write")
      inserts.push(value)
    }),
  }

  const tx: Record<string, unknown> = {
    execute: vi.fn(async () => undefined),
    select: vi.fn(() => selectChain),
    insert: vi.fn(() => insertChain),
    update: vi.fn(() => updateChain),
  }

  vi.mocked(findAcceptedSnapshot).mockImplementation(async () => {
    events.push("snapshot-read")
    if (!options.previous) {
      return null
    }
    return {
      config: options.previous.config,
      hash: options.previous.hash,
      acceptedAt: NOW,
    }
  })

  vi.mocked(synchronizeRegistry).mockImplementation(async () => {
    events.push("registry-sync")
  })

  vi.mocked(lockConfiguration).mockImplementation(async () => {
    events.push("lock")
  })

  const handle: Record<string, unknown> = {
    transaction: vi.fn(async (run: (inner: unknown) => unknown) => run(tx)),
  }

  return {
    handle: handle as unknown as DatabaseHandle,
    events,
    inserts,
    tx,
  }
}

describe("acceptDesiredConfiguration", () => {
  beforeEach(() => {
    vi.mocked(defaultHandle.transaction).mockReset()
    vi.mocked(lockConfiguration).mockReset()
    vi.mocked(synchronizeRegistry).mockReset()
    vi.mocked(findAcceptedSnapshot).mockReset()
  })

  it("locks, re-reads the accepted snapshot, writes, and syncs registry in one transaction", async () => {
    const config = validateMonitoringConfig(baseConfig())
    const hash = hashMonitoringConfig(config)
    const { handle, events, inserts } = makeTx({
      previous: { config, hash },
    })

    const result = await acceptDesiredConfiguration(config, NOW, handle)

    expect(result).toEqual(config)
    expect(events[0]).toBe("lock")
    expect(events).toEqual([
      "lock",
      "snapshot-read",
      "snapshot-write",
      "update",
      "registry-sync",
    ])
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toEqual(
      expect.objectContaining({
        status: "accepted",
        configHash: hash,
        source: "edge-config",
      })
    )
    expect(synchronizeRegistry).toHaveBeenCalledWith(
      expect.anything(),
      config,
      hash,
      NOW,
      "runtime"
    )
  })

  it("uses the locked previous snapshot so a stale pre-lock read cannot win", async () => {
    const previous = validateMonitoringConfig(baseConfig())
    const previousHash = hashMonitoringConfig(previous)
    // Desired removes the only monitor: destructive vs previous.
    const desired = validateMonitoringConfig({
      ...previous,
      configVersion: 2,
      monitors: [],
    })
    const desiredHash = hashMonitoringConfig(desired)
    const { handle, events, inserts } = makeTx({
      previous: { config: previous, hash: previousHash },
      approvals: [
        {
          id: "appr-1",
          targetConfigHash: desiredHash,
          action: "destructive_config_change",
          expiresAt: new Date("2026-07-18T04:10:00.000Z"),
          consumedAt: null,
        },
      ],
      consumeSucceeds: true,
    })

    const result = await acceptDesiredConfiguration(desired, NOW, handle)

    expect(result).toEqual(desired)
    expect(events[0]).toBe("lock")
    expect(events).toContain("snapshot-read")
    expect(events).toContain("approval-lookup")
    expect(events).toContain("approval-consume")
    expect(events.at(-1)).toBe("registry-sync")
    expect(inserts[0]).toEqual(
      expect.objectContaining({
        status: "accepted",
        configHash: desiredHash,
      })
    )
  })

  it("ties approval consumption to the accepted candidate hash under the lock", async () => {
    const previous = validateMonitoringConfig(baseConfig())
    const previousHash = hashMonitoringConfig(previous)
    const desired = validateMonitoringConfig({
      ...previous,
      configVersion: 2,
      monitors: [],
    })
    const desiredHash = hashMonitoringConfig(desired)
    // No approval row: destructive change must fall back to previous.
    const { handle, inserts } = makeTx({
      previous: { config: previous, hash: previousHash },
      approvals: [],
    })

    const result = await acceptDesiredConfiguration(desired, NOW, handle)

    expect(result).toEqual(previous)
    expect(inserts[0]).toEqual(
      expect.objectContaining({
        status: "rejected",
        rejectionReason: "DESTRUCTIVE_APPROVAL_REQUIRED",
        configHash: desiredHash,
      })
    )
    // Fallback still re-syncs the accepted previous hash so registry agrees.
    expect(synchronizeRegistry).toHaveBeenCalledWith(
      expect.anything(),
      previous,
      previousHash,
      NOW,
      "runtime"
    )
  })

  it("falls back when conditional approval consumption loses its race", async () => {
    const previous = validateMonitoringConfig(baseConfig())
    const previousHash = hashMonitoringConfig(previous)
    const desired = validateMonitoringConfig({
      ...previous,
      configVersion: 2,
      monitors: [],
    })
    const desiredHash = hashMonitoringConfig(desired)
    const { handle, inserts, events } = makeTx({
      previous: { config: previous, hash: previousHash },
      approvals: [
        {
          id: "appr-lost",
          targetConfigHash: desiredHash,
          action: "destructive_config_change",
          expiresAt: new Date("2026-07-18T04:10:00.000Z"),
          consumedAt: null,
        },
      ],
      consumeSucceeds: false,
    })

    const result = await acceptDesiredConfiguration(desired, NOW, handle)

    expect(result).toEqual(previous)
    expect(events).toContain("approval-consume")
    expect(inserts[0]).toEqual(
      expect.objectContaining({
        status: "rejected",
        rejectionReason: "DESTRUCTIVE_APPROVAL_REQUIRED",
      })
    )
  })

  it("records unavailable observations under the lock then throws after commit", async () => {
    const { handle, events, inserts } = makeTx({ previous: null })
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)

    await expect(
      acceptDesiredConfiguration(undefined, NOW, handle)
    ).rejects.toThrow("INVALID_CONFIGURATION_WITHOUT_FALLBACK")

    expect(events).toEqual(["lock", "snapshot-read", "snapshot-write"])
    expect(inserts[0]).toEqual(
      expect.objectContaining({
        status: "rejected",
        rejectionReason: "INVALID_CONFIGURATION_WITHOUT_FALLBACK",
        configVersion: 0,
      })
    )
    expect(synchronizeRegistry).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it("opens the transaction on the given handle, not the default pool", async () => {
    const config = validateMonitoringConfig(baseConfig())
    const hash = hashMonitoringConfig(config)
    const { handle } = makeTx({ previous: { config, hash } })

    await acceptDesiredConfiguration(config, NOW, handle)

    expect(handle.transaction).toHaveBeenCalledOnce()
    expect(defaultHandle.transaction).not.toHaveBeenCalled()
  })

  it("matches pure acceptance evaluation for a no-op desired document", async () => {
    const config = validateMonitoringConfig(baseConfig())
    const hash = hashMonitoringConfig(config)
    const pure = evaluateConfigurationAcceptance(
      config,
      { config, hash },
      { now: NOW }
    )
    expect(pure.status).toBe("accepted")

    const { handle } = makeTx({ previous: { config, hash } })
    const result = await acceptDesiredConfiguration(config, NOW, handle)
    expect(result).toEqual(config)
  })
})
