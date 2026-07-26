import { describe, expect, it, vi } from "vitest"

import {
  fetchPorkbunAccountDomains,
  type PorkbunFetcher,
  parsePorkbunExpiry,
} from "./porkbun"

vi.mock("server-only", () => ({}))

const credentials = {
  PORKBUN_API_KEY: "public-key",
  PORKBUN_SECRET_KEY: "secret-key",
}

function response(
  document: unknown,
  status = 200,
  headers?: HeadersInit
): Response {
  return new Response(JSON.stringify(document), { status, headers })
}

function domain(domainName: string, overrides: Record<string, unknown> = {}) {
  return {
    domain: domainName,
    expireDate: "2027-04-03 11:12:13",
    autoRenew: "1",
    notLocal: "0",
    status: "ACTIVE",
    apiAccess: "1",
    ...overrides,
  }
}

describe("fetchPorkbunAccountDomains", () => {
  it("uses read-only header authentication without a request body", async () => {
    const fetcher = vi.fn<PorkbunFetcher>(async () =>
      response({ status: "SUCCESS", domains: [] })
    )

    await fetchPorkbunAccountDomains({ env: credentials, fetcher })

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.porkbun.com/api/json/v3/domain/listAll?start=0",
      expect.objectContaining({
        method: "GET",
        headers: {
          accept: "application/json",
          "X-API-Key": "public-key",
          "X-Secret-API-Key": "secret-key",
        },
      })
    )
    expect(fetcher.mock.calls[0]?.[1].body).toBeUndefined()
  })

  it("paginates 1000-domain pages and returns account membership facts", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) =>
      domain(`domain-${index}.example`)
    )
    const fetcher = vi
      .fn<PorkbunFetcher>()
      .mockResolvedValueOnce(
        response({ status: "SUCCESS", domains: firstPage })
      )
      .mockResolvedValueOnce(
        response({
          status: "SUCCESS",
          domains: [domain("owned.example", { autoRenew: "0", notLocal: "1" })],
        })
      )

    const result = await fetchPorkbunAccountDomains({
      env: credentials,
      fetcher,
    })

    expect(result).toMatchObject({ outcome: "resolved" })
    expect(result.domains).toHaveLength(1001)
    expect(
      result.domains.find((item) => item.domain === "owned.example")
    ).toEqual({
      domain: "owned.example",
      expiresAt: new Date("2027-04-03T11:12:13.000Z"),
      autoRenew: false,
      notLocal: true,
      status: "ACTIVE",
      apiAccess: true,
    })
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "https://api.porkbun.com/api/json/v3/domain/listAll?start=1000"
    )
  })

  it("rejects malformed envelopes and ignores malformed records", async () => {
    const malformed = await fetchPorkbunAccountDomains({
      env: credentials,
      fetcher: async () => response({ status: "SUCCESS", domains: "wrong" }),
    })
    const partial = await fetchPorkbunAccountDomains({
      env: credentials,
      fetcher: async () =>
        response({
          status: "SUCCESS",
          domains: [
            null,
            { expireDate: "2027-01-01" },
            domain("valid.example"),
          ],
        }),
    })

    expect(malformed).toEqual({
      outcome: "failed",
      domains: [],
      reason: "malformed-response",
    })
    expect(partial).toMatchObject({ outcome: "resolved" })
    expect(partial.domains.map((item) => item.domain)).toEqual([
      "valid.example",
    ])
  })

  it("does not request Porkbun when either credential is missing", async () => {
    const fetcher = vi.fn<PorkbunFetcher>()

    await expect(
      fetchPorkbunAccountDomains({
        env: { PORKBUN_API_KEY: "present" },
        fetcher,
      })
    ).resolves.toEqual({ outcome: "unconfigured", domains: [] })
    await expect(
      fetchPorkbunAccountDomains({
        env: { PORKBUN_SECRET_KEY: "present" },
        fetcher,
      })
    ).resolves.toEqual({ outcome: "unconfigured", domains: [] })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("classifies rate limits and preserves the provider reset time", async () => {
    const result = await fetchPorkbunAccountDomains({
      env: credentials,
      fetcher: async () =>
        response({}, 429, { "x-ratelimit-reset": "1800000000" }),
    })

    expect(result).toEqual({
      outcome: "rate-limited",
      domains: [],
      retryAt: new Date("2027-01-15T08:00:00.000Z"),
    })
  })

  it("classifies timeouts and rejects oversized response bodies", async () => {
    const timeout = await fetchPorkbunAccountDomains({
      env: credentials,
      fetcher: async () => {
        throw new DOMException("timed out", "TimeoutError")
      },
    })
    const oversized = await fetchPorkbunAccountDomains({
      env: credentials,
      fetcher: async () =>
        response({ status: "SUCCESS", domains: [] }, 200, {
          "content-length": String(1024 * 1024 + 1),
        }),
    })

    expect(timeout).toEqual({
      outcome: "failed",
      domains: [],
      reason: "timeout",
    })
    expect(oversized).toEqual({
      outcome: "failed",
      domains: [],
      reason: "oversized-response",
    })
  })

  it("uses the documented UTC assumption for offset-free expiry values", () => {
    expect(parsePorkbunExpiry("2027-04-03 11:12:13")?.toISOString()).toBe(
      "2027-04-03T11:12:13.000Z"
    )
    expect(parsePorkbunExpiry("invalid")).toBeNull()
  })

  it("sanitizes and bounds status while retaining API access", async () => {
    const result = await fetchPorkbunAccountDomains({
      env: credentials,
      fetcher: async () =>
        response({
          status: "SUCCESS",
          domains: [
            domain("bounded.example", {
              status: `  ACTIVE\u202E${"x".repeat(250)}  `,
              apiAccess: "no",
            }),
          ],
        }),
    })

    expect(result).toMatchObject({ outcome: "resolved" })
    expect(result.domains[0]).toMatchObject({
      domain: "bounded.example",
      status: `ACTIVE${"x".repeat(194)}`,
      apiAccess: false,
    })
  })
})
