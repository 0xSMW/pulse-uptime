import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/db/client", () => {
  const chain: Record<string, unknown> = {}
  chain.from = () => chain
  chain.leftJoin = () => chain
  chain.where = async () => uptimeRows
  return { db: { select: () => chain } }
})

import { uptime24hByMonitorId } from "./queries"

let uptimeRows: Array<{
  id: string
  activatedAt: Date | null
  uptime24h: number | string | null
}> = []

const DAY_MS = 86_400_000

describe("uptime24hByMonitorId", () => {
  beforeEach(() => {
    uptimeRows = []
  })

  it("returns an empty map without querying when no ids are given", async () => {
    expect(await uptime24hByMonitorId([])).toEqual(new Map())
  })

  it("passes uptime through only once the completed window covers a full post-activation day", async () => {
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

    expect(uptime.get("settled")).toBe(99.5)
    expect(uptime.get("collecting")).toBeNull()
    expect(uptime.get("never-activated")).toBeNull()
  })

  it("reads null when the window is unlocked but holds no data", async () => {
    uptimeRows = [
      {
        id: "gap",
        activatedAt: new Date(Date.now() - 3 * DAY_MS),
        uptime24h: null,
      },
    ]
    expect((await uptime24hByMonitorId(["gap"])).get("gap")).toBeNull()
  })
})
