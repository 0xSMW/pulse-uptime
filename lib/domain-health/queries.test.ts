import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import type { DatabaseHandle } from "@/lib/db/client"

import { domainHealthByMonitorId } from "./queries"

function queryHandle(
  domainRows: unknown[] = [],
  certificateRows: unknown[] = []
) {
  const pendingRows = [domainRows, certificateRows]
  const select = vi.fn(() => {
    const rows = pendingRows.shift() ?? []
    const chain: Record<string, unknown> = {}
    chain.from = () => chain
    chain.where = async () => rows
    return chain
  })
  return { handle: { select } as unknown as DatabaseHandle, select }
}

describe("domainHealthByMonitorId", () => {
  it("fans shared apex facts out while keeping certificates on hostname and port", async () => {
    const { handle, select } = queryHandle(
      [
        {
          apexDomain: "example.com",
          expiresAt: new Date("2027-01-02T03:04:05Z"),
          registrar: "Example Registrar",
        },
      ],
      [
        {
          hostname: "www.example.com",
          port: 443,
          expiresAt: new Date("2026-11-12T13:14:15Z"),
          issuer: "Example CA",
        },
        {
          hostname: "api.example.com",
          port: 8443,
          expiresAt: new Date("2026-12-13T14:15:16Z"),
          issuer: "Private CA",
        },
      ]
    )

    const facts = await domainHealthByMonitorId(
      [
        { id: "www", url: "https://www.example.com/status" },
        { id: "www-copy", url: "https://www.example.com/ready" },
        { id: "api", url: "https://api.example.com:8443/health" },
        { id: "http", url: "http://blog.example.com" },
      ],
      handle
    )

    expect(select).toHaveBeenCalledTimes(2)
    expect(facts.get("www")).toEqual({
      apexDomain: "example.com",
      certExpiresAt: "2026-11-12T13:14:15.000Z",
      certIssuer: "Example CA",
      domainExpiresAt: "2027-01-02T03:04:05.000Z",
      domainRegistrar: "Example Registrar",
    })
    expect(facts.get("www-copy")).toEqual(facts.get("www"))
    expect(facts.get("api")).toEqual({
      apexDomain: "example.com",
      certExpiresAt: "2026-12-13T14:15:16.000Z",
      certIssuer: "Private CA",
      domainExpiresAt: "2027-01-02T03:04:05.000Z",
      domainRegistrar: "Example Registrar",
    })
    expect(facts.get("http")).toEqual({
      apexDomain: "example.com",
      certExpiresAt: null,
      certIssuer: null,
      domainExpiresAt: "2027-01-02T03:04:05.000Z",
      domainRegistrar: "Example Registrar",
    })
  })

  it("returns null facts for malformed URLs and missing shared assets", async () => {
    const { handle, select } = queryHandle([], [])

    const facts = await domainHealthByMonitorId(
      [
        { id: "missing", url: "https://missing.example.com" },
        { id: "malformed", url: "not a URL" },
      ],
      handle
    )

    expect(select).toHaveBeenCalledTimes(2)
    expect(facts.get("missing")).toEqual({
      apexDomain: "example.com",
      certExpiresAt: null,
      certIssuer: null,
      domainExpiresAt: null,
      domainRegistrar: null,
    })
    expect(facts.get("malformed")).toEqual({
      apexDomain: null,
      certExpiresAt: null,
      certIssuer: null,
      domainExpiresAt: null,
      domainRegistrar: null,
    })
  })

  it("does no database work when no monitor yields an asset target", async () => {
    const { handle, select } = queryHandle()

    const facts = await domainHealthByMonitorId(
      [
        { id: "malformed", url: "not a URL" },
        { id: "local", url: "http://localhost:3000" },
      ],
      handle
    )

    expect(select).not.toHaveBeenCalled()
    expect(facts.get("malformed")?.apexDomain).toBeNull()
    expect(facts.get("local")?.certExpiresAt).toBeNull()
  })
})
