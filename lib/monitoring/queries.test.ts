import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/db/client", () => {
  const chain: Record<string, unknown> = {}
  chain.from = () => chain
  chain.leftJoin = () => chain
  chain.where = async () => {
    queryCount += 1
    return uptimeRows
  }
  return { db: { select: () => chain } }
})

import { uptime24hByMonitorId } from "./queries"

let uptimeRows: Array<{
  id: string
  activatedAt: Date | null
  uptime24h: number | string | null
}> = []
let queryCount = 0

const DAY_MS = 86_400_000

describe("uptime24hByMonitorId", () => {
  beforeEach(() => {
    uptimeRows = []
    queryCount = 0
  })

  it("returns an empty map without querying when no ids are given", async () => {
    expect(await uptime24hByMonitorId([])).toEqual(new Map())
    expect(queryCount).toBe(0)
  })

  it("settles unlocked uptime and moves a locked monitor's figure to observedUptime", async () => {
    const longActive = new Date(Date.now() - 3 * DAY_MS)
    const justActivated = new Date(Date.now() - DAY_MS / 2)
    uptimeRows = [
      { id: "settled", activatedAt: longActive, uptime24h: "99.5" },
      { id: "collecting", activatedAt: justActivated, uptime24h: "100" },
      { id: "never-activated", activatedAt: null, uptime24h: null },
    ]

    const uptime = await uptime24hByMonitorId([
      "settled",
      "collecting",
      "never-activated",
    ])

    expect(uptime.get("settled")).toEqual({
      uptime24h: 99.5,
      observedUptime: null,
    })
    expect(uptime.get("collecting")).toEqual({
      uptime24h: null,
      observedUptime: 100,
    })
    expect(uptime.get("never-activated")).toEqual({
      uptime24h: null,
      observedUptime: null,
    })
    expect(queryCount).toBe(1)
  })

  it("reads null on both fields for an unlocked window holding no data", async () => {
    uptimeRows = [
      {
        id: "gap",
        activatedAt: new Date(Date.now() - 3 * DAY_MS),
        uptime24h: null,
      },
    ]
    expect((await uptime24hByMonitorId(["gap"])).get("gap")).toEqual({
      uptime24h: null,
      observedUptime: null,
    })
  })

  it("reads null observed before the first post-activation bucket completes", async () => {
    uptimeRows = [
      {
        id: "fresh",
        activatedAt: new Date(Date.now() - 5 * 60_000),
        uptime24h: null,
      },
    ]
    expect((await uptime24hByMonitorId(["fresh"])).get("fresh")).toEqual({
      uptime24h: null,
      observedUptime: null,
    })
  })
})
