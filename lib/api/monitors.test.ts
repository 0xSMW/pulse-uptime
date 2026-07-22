import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => {
  const chain: Record<string, unknown> = {}
  chain.from = () => chain
  chain.innerJoin = () => chain
  chain.where = async () => []
  return { db: { impl: "default-db", select: () => chain } }
})
vi.mock("./config-mutation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config-mutation")>()),
  requireAcceptedConfig: vi.fn(async () => ({
    config: BASE_CONFIG,
    hash: "hash",
    acceptedAt: new Date(0),
  })),
  applyConfigChange: vi.fn(
    async (_principalKey: string, mutator: (config: unknown) => unknown) =>
      mutator(BASE_CONFIG)
  ),
}))
vi.mock("@/lib/monitoring/queries", () => ({
  uptime24hByMonitorId: vi.fn(
    async (ids: readonly string[]) =>
      new Map(ids.map((id) => [id, { uptime24h: 99.5, observedUptime: null }]))
  ),
}))

import type { DatabaseHandle } from "@/lib/db/client"
import { db } from "@/lib/db/client"
import { uptime24hByMonitorId } from "@/lib/monitoring/queries"

import { applyConfigChange } from "./config-mutation"
import {
  archiveMonitor,
  createMonitor,
  listMonitors,
  MonitorApiError,
  mergeMonitorPatch,
  parseCreateMonitor,
  parsePatchMonitor,
  requireMonitor,
  setMonitorEnabled,
  updateMonitor,
} from "./monitors"

const EXISTING = parseCreateMonitor({
  id: "site-home",
  name: "Site",
  url: "https://example.com",
})
const BASE_CONFIG = {
  schemaVersion: 2,
  configVersion: 1,
  groups: [],
  monitors: [EXISTING],
}

describe("monitor API request parsing", () => {
  it("applies the documented safe defaults to creates", () => {
    expect(
      parseCreateMonitor({
        id: "site-home",
        name: "Site",
        url: "https://example.com",
      })
    ).toMatchObject({
      id: "site-home",
      enabled: true,
      method: "GET",
      intervalMinutes: 1,
      timeoutMs: 8000,
      expectedStatus: { minimum: 200, maximum: 399 },
      failureThreshold: 2,
      recoveryThreshold: 2,
    })
  })

  it("requires a nonempty strict patch and preserves nested fields", () => {
    const groups = [{ id: "production", name: "Production" }]
    const monitor = parseCreateMonitor(
      {
        id: "site-home",
        name: "Site",
        url: "https://example.com",
        groupId: "production",
        expectedStatus: { minimum: 200, maximum: 299 },
      },
      groups
    )
    expect(() => parsePatchMonitor({})).toThrow()
    expect(() => parsePatchMonitor({ unknown: true })).toThrow()
    expect(
      mergeMonitorPatch(monitor, parsePatchMonitor({ name: "Renamed" }))
    ).toMatchObject({
      name: "Renamed",
      groupId: "production",
      expectedStatus: { minimum: 200, maximum: 299 },
    })
  })

  it("accepts a group ID or legacy group name but never both", () => {
    const groups = [{ id: "production", name: "Production" }]
    expect(
      parseCreateMonitor(
        {
          id: "site-one",
          name: "One",
          url: "https://one.example.com",
          group: "production",
        },
        groups
      ).groupId
    ).toBe("production")
    expect(() =>
      parseCreateMonitor(
        {
          id: "site-two",
          name: "Two",
          url: "https://two.example.com",
          group: "Production",
          groupId: "production",
        },
        groups
      )
    ).toThrow()
  })

  it("rejects an unknown legacy group name instead of creating it", () => {
    expect(() =>
      parseCreateMonitor(
        {
          id: "site-unknown-group",
          name: "Unknown group",
          url: "https://unknown.example.com",
          group: "Productionn",
        },
        [{ id: "production", name: "Production" }]
      )
    ).toThrowError(expect.objectContaining({ code: "GROUP_NOT_FOUND" }))
  })

  it("accepts an explicit null groupId to clear but rejects an empty string", () => {
    const groups = [{ id: "production", name: "Production" }]
    const monitor = parseCreateMonitor(
      {
        id: "site-home",
        name: "Site",
        url: "https://example.com",
        groupId: "production",
      },
      groups
    )
    expect(parsePatchMonitor({ groupId: null }).groupId).toBeNull()
    expect(
      mergeMonitorPatch(monitor, parsePatchMonitor({ groupId: null })).groupId
    ).toBeNull()
    // The empty string that the raw --group-id "" once sent is still rejected at
    // the schema, so the CLI maps it to null rather than letting it reach here.
    expect(() => parsePatchMonitor({ groupId: "" })).toThrow()
  })
})

describe("list uptime", () => {
  it("attaches the 24h uptime for the returned page and asks only for page ids", async () => {
    const result = await listMonitors({ cursor: null, limit: 10 })
    expect(result.monitors).toHaveLength(1)
    expect(result.monitors[0]).toMatchObject({
      id: "site-home",
      uptime: 99.5,
      observedUptime: null,
    })
    expect(uptime24hByMonitorId).toHaveBeenCalledWith(["site-home"])
  })

  it("passes the observed figure through for a collecting monitor", async () => {
    vi.mocked(uptime24hByMonitorId).mockResolvedValueOnce(
      new Map([["site-home", { uptime24h: null, observedUptime: 99.981 }]])
    )
    const result = await listMonitors({ cursor: null, limit: 10 })
    expect(result.monitors[0]).toMatchObject({
      id: "site-home",
      uptime: null,
      observedUptime: 99.981,
    })
  })

  it("reads null when the uptime lookup has no row for a monitor", async () => {
    vi.mocked(uptime24hByMonitorId).mockResolvedValueOnce(new Map())
    const result = await listMonitors({ cursor: null, limit: 10 })
    expect(result.monitors[0]).toMatchObject({
      id: "site-home",
      uptime: null,
      observedUptime: null,
    })
  })
})

describe("clear then reassign a group through updateMonitor", () => {
  it("clears the group with null and then reassigns the same group", async () => {
    const groups = [{ id: "production", name: "Production" }]
    const grouped = parseCreateMonitor(
      {
        id: "site-grp",
        name: "Grouped",
        url: "https://grouped.example.com",
        groupId: "production",
      },
      groups
    )
    let config: unknown = {
      schemaVersion: 2,
      configVersion: 1,
      settings: {},
      groups,
      monitors: [grouped],
    }
    const step = async (
      _principalKey: string,
      mutator: (value: unknown) => unknown
    ) => {
      config = mutator(config)
      return config
    }
    vi.mocked(applyConfigChange)
      .mockImplementationOnce(step as never)
      .mockImplementationOnce(step as never)

    const cleared = await updateMonitor(
      "site-grp",
      { groupId: null },
      "human:1"
    )
    expect(cleared).toMatchObject({
      id: "site-grp",
      groupId: null,
      group: null,
    })

    const reassigned = await updateMonitor(
      "site-grp",
      { groupId: "production" },
      "human:1"
    )
    expect(reassigned).toMatchObject({
      id: "site-grp",
      groupId: "production",
      group: "Production",
    })
  })
})

describe("legacy group assignment", () => {
  it("leaves configuration unchanged when the legacy name is unknown", async () => {
    const groups = [{ id: "production", name: "Production" }]
    const monitor = parseCreateMonitor(
      {
        id: "site-grp",
        name: "Grouped",
        url: "https://grouped.example.com",
        groupId: "production",
      },
      groups
    )
    const config = {
      schemaVersion: 2,
      configVersion: 1,
      settings: {},
      groups,
      monitors: [monitor],
    }
    vi.mocked(applyConfigChange).mockImplementationOnce((async (
      _principalKey: string,
      mutator: (value: unknown) => unknown
    ) => mutator(config)) as never)

    await expect(
      updateMonitor("site-grp", { group: "Productionn" }, "human:1")
    ).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" })
    expect(config.groups).toEqual(groups)
  })
})

describe("single monitor runtime state", () => {
  function runtimeHandle(
    rows: Array<{ state: string; createdAt: Date; updatedAt: Date }>
  ) {
    const chain: Record<string, unknown> = {}
    chain.from = () => chain
    chain.innerJoin = () => chain
    chain.where = async () => rows
    return { select: () => chain } as unknown as DatabaseHandle
  }

  it("returns state and registry timestamps from the state join, and no uptime", async () => {
    const handle = runtimeHandle([
      {
        state: "UP",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-02T03:04:05Z"),
      },
    ])
    const monitor = await requireMonitor("site-home", handle)
    expect(monitor).toMatchObject({
      id: "site-home",
      state: "UP",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T03:04:05.000Z",
    })
    expect(monitor).not.toHaveProperty("uptime")
  })

  it("returns the config shape alone when no registry row exists yet", async () => {
    const monitor = await requireMonitor("site-home", runtimeHandle([]))
    expect(monitor).toMatchObject({
      id: "site-home",
      group: null,
      groupId: null,
    })
    expect(monitor).not.toHaveProperty("state")
    expect(monitor).not.toHaveProperty("createdAt")
  })

  it("throws MONITOR_NOT_FOUND for an unknown id", async () => {
    await expect(
      requireMonitor("missing", runtimeHandle([]))
    ).rejects.toBeInstanceOf(MonitorApiError)
  })
})

describe("handle threading to applyConfigChange (finding: the mutation and the idempotency completion must commit in the same transaction, so the route's tx must reach applyConfigChange, not the default pool)", () => {
  const routeTx = { impl: "route-tx" } as unknown as DatabaseHandle

  it("createMonitor forwards the given handle", async () => {
    await createMonitor(
      { id: "site-two", name: "Two", url: "https://two.example.com" },
      "human:1",
      routeTx
    )
    expect(applyConfigChange).toHaveBeenLastCalledWith(
      "human:1",
      expect.any(Function),
      routeTx
    )
  })

  it("createMonitor defaults to the db handle when none is given", async () => {
    await createMonitor(
      { id: "site-three", name: "Three", url: "https://three.example.com" },
      "human:1"
    )
    expect(applyConfigChange).toHaveBeenLastCalledWith(
      "human:1",
      expect.any(Function),
      db
    )
  })

  it("updateMonitor forwards the given handle", async () => {
    await updateMonitor("site-home", { name: "Renamed" }, "human:1", routeTx)
    expect(applyConfigChange).toHaveBeenLastCalledWith(
      "human:1",
      expect.any(Function),
      routeTx
    )
  })

  it("setMonitorEnabled forwards the given handle", async () => {
    await setMonitorEnabled("site-home", false, "human:1", routeTx)
    expect(applyConfigChange).toHaveBeenLastCalledWith(
      "human:1",
      expect.any(Function),
      routeTx
    )
  })

  it("archiveMonitor forwards the given handle to applyConfigChange and to the archived-registry fallback read on MONITOR_NOT_FOUND", async () => {
    vi.mocked(applyConfigChange).mockRejectedValueOnce(
      new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found")
    )
    const chain: Record<string, unknown> = {}
    chain.from = vi.fn(() => chain)
    chain.where = vi.fn(() => chain)
    chain.limit = vi.fn(async () => [{ id: "site-missing" }])
    const fallbackHandle = {
      select: vi.fn(() => chain),
    } as unknown as DatabaseHandle

    const result = await archiveMonitor(
      "site-missing",
      "human:1",
      fallbackHandle
    )

    expect(applyConfigChange).toHaveBeenLastCalledWith(
      "human:1",
      expect.any(Function),
      fallbackHandle
    )
    expect(fallbackHandle.select).toHaveBeenCalled()
    expect(result).toEqual({ id: "site-missing", archived: true })
  })
})
