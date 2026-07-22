import { beforeEach, describe, expect, it, vi } from "vitest"

const { dbSelectMock, domainHealthByMonitorIdMock } = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
  domainHealthByMonitorIdMock: vi.fn(),
}))

vi.mock("@/lib/db/client", () => ({ db: { select: dbSelectMock } }))
vi.mock("@/lib/domain-health/queries", () => ({
  domainHealthByMonitorId: domainHealthByMonitorIdMock,
}))
vi.mock("@/lib/reporting/queries/raw-availability", () => ({
  fetchRawAvailabilityBuckets: vi.fn(async () => []),
}))

import { domainHealthByMonitorId } from "@/lib/domain-health/queries"

import { listDashboardMonitors } from "./queries"

function selectChain(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    // biome-ignore lint/suspicious/noThenProperty: drizzle builders are PromiseLike
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (reason: unknown) => unknown
    ) => promise.then(resolve, reject),
  }
  return chain
}

describe("dashboard domain health", () => {
  beforeEach(() => {
    const rows = [
      [
        {
          id: "site-home",
          name: "Home",
          url: "https://example.com",
          state: "UP",
          latestLatencyMs: 120,
          lastCheckedAt: new Date("2026-07-22T01:02:03Z"),
          activatedAt: new Date("2026-07-20T00:00:00Z"),
          activeIncidentOpenedAt: null,
          uptime24h: "99.9",
        },
      ],
      [],
    ]
    dbSelectMock.mockReset()
    dbSelectMock.mockImplementation(() => selectChain(rows.shift() ?? []))
    domainHealthByMonitorIdMock.mockReset()
    domainHealthByMonitorIdMock.mockResolvedValue(
      new Map([
        [
          "site-home",
          {
            apexDomain: "example.com",
            certExpiresAt: "2026-11-12T13:14:15.000Z",
            certIssuer: "Example CA",
            domainExpiresAt: "2027-01-02T03:04:05.000Z",
            domainRegistrar: "Example Registrar",
          },
        ],
      ])
    )
  })

  it("loads page facts once and projects only the existing expiry fields", async () => {
    const [monitor] = await listDashboardMonitors()

    expect(domainHealthByMonitorId).toHaveBeenCalledWith([
      { id: "site-home", url: "https://example.com" },
    ])
    expect(monitor).toMatchObject({
      id: "site-home",
      certExpiresAt: "2026-11-12T13:14:15.000Z",
      domainExpiresAt: "2027-01-02T03:04:05.000Z",
    })
    expect(monitor).not.toHaveProperty("apexDomain")
    expect(monitor).not.toHaveProperty("certIssuer")
    expect(monitor).not.toHaveProperty("domainRegistrar")
  })
})
