import { describe, expect, it, vi } from "vitest"

import { fetchDomainFacts, type RdapFetcher } from "./rdap"

function jsonResponse(document: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(document),
  }
}

const rdapDocument = {
  events: [
    { eventAction: "registration", eventDate: "2023-01-22T10:44:22Z" },
    { eventAction: "expiration", eventDate: "2027-01-22T10:44:22Z" },
  ],
  entities: [
    {
      roles: ["registrar"],
      vcardArray: [
        "vcard",
        [
          ["version", {}, "text", "4.0"],
          ["fn", {}, "text", "Namecheap, Inc."],
        ],
      ],
    },
  ],
}

describe("fetchDomainFacts", () => {
  it("parses the expiration event and registrar name", async () => {
    const fetcher = vi.fn<RdapFetcher>(async () => jsonResponse(rdapDocument))
    const facts = await fetchDomainFacts("klu.ai", fetcher)
    expect(facts.expiresAt?.toISOString()).toBe("2027-01-22T10:44:22.000Z")
    expect(facts.registrar).toBe("Namecheap, Inc.")
    expect(facts.outcome).toBe("resolved")
    expect(fetcher).toHaveBeenCalledWith(
      "https://rdap.org/domain/klu.ai",
      expect.objectContaining({
        headers: { accept: "application/rdap+json" },
      })
    )
  })

  it("returns uncovered null facts for a TLD without RDAP coverage", async () => {
    const fetcher = vi.fn<RdapFetcher>(async () => jsonResponse({}, 404))
    expect(await fetchDomainFacts("gxd.io", fetcher)).toEqual({
      expiresAt: null,
      registrar: null,
      outcome: "uncovered",
    })
  })

  it("returns failed null facts on transport errors", async () => {
    const fetcher = vi.fn<RdapFetcher>(async () => {
      throw new Error("network down")
    })
    expect(await fetchDomainFacts("klu.ai", fetcher)).toEqual({
      expiresAt: null,
      registrar: null,
      outcome: "failed",
    })
  })

  it("returns failed null facts on non-404 error statuses", async () => {
    const fetcher = vi.fn<RdapFetcher>(async () => jsonResponse({}, 429))
    expect(await fetchDomainFacts("klu.ai", fetcher)).toEqual({
      expiresAt: null,
      registrar: null,
      outcome: "failed",
    })
  })

  it("returns null facts on unparseable JSON", async () => {
    const fetcher = vi.fn<RdapFetcher>(async () => ({
      ok: true,
      status: 200,
      text: async () => "<html>not json</html>",
    }))
    expect(await fetchDomainFacts("klu.ai", fetcher)).toEqual({
      expiresAt: null,
      registrar: null,
      outcome: "failed",
    })
  })

  it("abandons an oversized streamed body without buffering it", async () => {
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024))
    let pushed = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 32 chunks of 64KB exceed the 1MB cap partway through.
        if (pushed < 32) {
          pushed += 1
          controller.enqueue(chunk)
        } else {
          controller.close()
        }
      },
    })
    const fetcher = vi.fn<RdapFetcher>(async () => ({
      ok: true,
      status: 200,
      body,
      text: async () => {
        throw new Error("text() must not be used when a body stream exists")
      },
    }))
    expect(await fetchDomainFacts("klu.ai", fetcher)).toEqual({
      expiresAt: null,
      registrar: null,
      outcome: "failed",
    })
    // The cap tripped mid-stream rather than after full buffering.
    expect(pushed).toBeLessThan(32)
  })

  it("ignores malformed events and entities without failing", async () => {
    const fetcher = vi.fn<RdapFetcher>(async () =>
      jsonResponse({
        events: [
          null,
          { eventAction: "expiration", eventDate: "not a date" },
          { eventAction: "expiration" },
        ],
        entities: [{ roles: ["registrant"] }, { roles: ["registrar"] }],
      })
    )
    expect(await fetchDomainFacts("klu.ai", fetcher)).toEqual({
      expiresAt: null,
      registrar: null,
      outcome: "resolved",
    })
  })
})
