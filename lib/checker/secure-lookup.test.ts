import type { LookupAddress } from "node:dns"
import { describe, expect, it } from "vitest"

import { BlockedTargetError } from "./ip-policy"
import { createSecureLookup } from "./secure-lookup"

type LookupOptions = { all?: boolean; family?: number }

function runLookup(
  addresses: readonly LookupAddress[],
  lookupOptions: LookupOptions = {}
) {
  const lookup = createSecureLookup({ resolveAll: async () => addresses })
  return new Promise<{
    error: NodeJS.ErrnoException | null
    address: string | LookupAddress[]
    family?: number
  }>((resolve) =>
    lookup("example.com", lookupOptions as never, (error, address, family) =>
      resolve({ error, address, family })
    )
  )
}

describe("secure connection lookup", () => {
  it("returns the first ordered address without reporting selection", async () => {
    const addresses = [
      { address: "8.8.8.8", family: 4 },
      { address: "8.8.4.4", family: 4 },
    ]
    const result = await runLookup(addresses)
    expect(result.error).toBeNull()
    expect(result.address).toBe("8.8.8.8")
    expect(result.family).toBe(4)
  })

  it("rejects all answers when one answer is private", async () => {
    const result = await runLookup([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ])
    expect(result.error).toBeInstanceOf(BlockedTargetError)
  })

  it("returns ENOTFOUND for an empty answer", async () => {
    const result = await runLookup([])
    expect(result.error?.code).toBe("ENOTFOUND")
  })

  it("rejects a mismatched resolver address family", async () => {
    const result = await runLookup([{ address: "8.8.8.8", family: 6 }])
    expect(result.error).toBeInstanceOf(BlockedTargetError)
  })

  it("preserves resolver errors", async () => {
    const resolverError = Object.assign(new Error("dns unavailable"), {
      code: "EAI_AGAIN",
    })
    const lookup = createSecureLookup({
      resolveAll: async () => {
        throw resolverError
      },
    })
    const result = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      lookup("example.com", {}, (error) => resolve(error))
    )
    expect(result).toBe(resolverError)
  })

  // postmark: status.postmarkapp.com resolves IPv6-first. A serverless runtime
  // without IPv6 egress cannot reach the IPv6 address, so with no family request
  // the pin must prefer the routable IPv4 answer while still validating every
  // address as public.
  describe("dual-stack family preference (postmark)", () => {
    const dualStackV6First = [
      { address: "2a04:4e42:69::347", family: 6 },
      { address: "199.232.165.91", family: 4 },
    ]

    it("prefers IPv4 for the single pin when no family is requested", async () => {
      const result = await runLookup(dualStackV6First)
      expect(result.error).toBeNull()
      expect(result.address).toBe("199.232.165.91")
      expect(result.family).toBe(4)
    })

    it("orders IPv4 first in the all-address list when no family is requested", async () => {
      const result = await runLookup(dualStackV6First, { all: true })
      expect(result.address).toEqual([
        { address: "199.232.165.91", family: 4 },
        { address: "2a04:4e42:69::347", family: 6 },
      ])
    })

    it("honors an explicit IPv6 family request", async () => {
      const result = await runLookup(dualStackV6First, { family: 6 })
      expect(result.address).toBe("2a04:4e42:69::347")
      expect(result.family).toBe(6)
    })

    it("honors an explicit IPv4 family request", async () => {
      const result = await runLookup(dualStackV6First, { family: 4 })
      expect(result.address).toBe("199.232.165.91")
      expect(result.family).toBe(4)
    })

    it("falls back to the only family when the requested one is absent", async () => {
      const ipv6Only = [{ address: "2a04:4e42:69::347", family: 6 }]
      const result = await runLookup(ipv6Only, { family: 4 })
      expect(result.address).toBe("2a04:4e42:69::347")
      expect(result.family).toBe(6)
    })
  })

  // resend: resend-status.com's apex alias returns a large, fast-rotating Vercel
  // anycast pool. The all-address callback must return every validated member so
  // Node's autoSelectFamily can fail over past a pool member the runtime's egress
  // cannot reach instead of being collapsed to a single pinned address.
  describe("multi-address failover (resend)", () => {
    it("returns the full validated list for the all-address callback", async () => {
      const pool = [
        { address: "76.76.21.9", family: 4 },
        { address: "76.76.21.61", family: 4 },
        { address: "76.76.21.142", family: 4 },
        { address: "76.76.21.241", family: 4 },
      ]
      const result = await runLookup(pool, { all: true })
      expect(result.address).toEqual(pool)
    })

    it("preserves resolver order within a family so failover walks the pool", async () => {
      const pool = [
        { address: "151.101.1.195", family: 4 },
        { address: "151.101.65.195", family: 4 },
      ]
      const result = await runLookup(pool, { all: true })
      expect(result.address).toEqual(pool)
    })

    it("still returns a single validated address for a single-A-record host", async () => {
      const result = await runLookup([{ address: "8.8.4.4", family: 4 }], {
        all: true,
      })
      expect(result.address).toEqual([{ address: "8.8.4.4", family: 4 }])
    })

    it("rejects the whole all-address answer when any member is private", async () => {
      const result = await runLookup(
        [
          { address: "76.76.21.9", family: 4 },
          { address: "169.254.1.1", family: 4 },
        ],
        { all: true }
      )
      expect(result.error).toBeInstanceOf(BlockedTargetError)
    })
  })
})
