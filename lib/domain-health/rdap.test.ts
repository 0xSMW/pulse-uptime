import { describe, expect, it, vi } from "vitest"

import { createSecureConnect } from "@/lib/checker/checker"
import type { SecureLookup } from "@/lib/checker/secure-lookup"
import type { ManagedDispatcher } from "@/lib/checker/types"

import {
  fetchDomainFacts,
  type RdapFetcher,
  type RdapTransportDependencies,
} from "./rdap"

function jsonResponse(
  document: unknown,
  status = 200
): Awaited<ReturnType<RdapFetcher>> {
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

function fakeDispatcher() {
  return {
    close: vi.fn(async () => undefined),
  } as unknown as ManagedDispatcher
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
        redirect: "manual",
      })
    )
  })

  it("follows a registry redirect with the secure transport and preserves facts", async () => {
    const dispatchers = [fakeDispatcher(), fakeDispatcher()]
    const createDispatcher = vi
      .fn<NonNullable<RdapTransportDependencies["createDispatcher"]>>()
      .mockReturnValueOnce(dispatchers[0]!)
      .mockReturnValueOnce(dispatchers[1]!)
    const request = vi
      .fn<NonNullable<RdapTransportDependencies["request"]>>()
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: { location: "https://registry.example/domain/klu.ai" },
        body: { destroy: vi.fn() },
        text: async () => "",
      })
      .mockResolvedValueOnce(jsonResponse(rdapDocument))

    const facts = await fetchDomainFacts("klu.ai", undefined, {
      createDispatcher,
      request,
      resolveAll: async () => [{ address: "8.8.8.8", family: 4 }],
    })

    expect(facts.expiresAt?.toISOString()).toBe("2027-01-22T10:44:22.000Z")
    expect(facts.registrar).toBe("Namecheap, Inc.")
    expect(facts.outcome).toBe("resolved")
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0]?.[1].maxRedirections).toBe(0)
    expect(request.mock.calls[1]?.[0].href).toBe(
      "https://registry.example/domain/klu.ai"
    )
    expect(createDispatcher).toHaveBeenCalledTimes(2)
    expect(dispatchers[0]?.close).toHaveBeenCalledOnce()
    expect(dispatchers[1]?.close).toHaveBeenCalledOnce()
  })

  it("rejects a redirect whose destination resolves to a private address", async () => {
    const dispatcher = fakeDispatcher()
    const lookups = new Map<string, SecureLookup>()
    const createDispatcher = vi.fn(
      (
        options: Parameters<
          NonNullable<RdapTransportDependencies["createDispatcher"]>
        >[0]
      ) => {
        lookups.set(options.origin, options.lookup)
        return dispatcher
      }
    )
    const request = vi.fn(
      async (url: URL): Promise<Awaited<ReturnType<RdapFetcher>>> => {
        if (url.hostname === "rdap.org") {
          return {
            ok: false,
            status: 302,
            headers: { location: "https://internal.example/domain/klu.ai" },
            text: async () => "",
          }
        }
        const lookup = lookups.get(url.origin)
        if (!lookup) {
          throw new Error("lookup was not installed")
        }
        await new Promise<void>((resolve, reject) => {
          lookup(url.hostname, { all: true }, (error) => {
            if (error) {
              reject(error)
            } else {
              resolve()
            }
          })
        })
        return jsonResponse(rdapDocument)
      }
    )

    expect(
      await fetchDomainFacts("klu.ai", undefined, {
        createDispatcher,
        request,
        resolveAll: async (hostname) => [
          {
            address: hostname === "internal.example" ? "127.0.0.1" : "8.8.8.8",
            family: 4,
          },
        ],
      })
    ).toEqual({ expiresAt: null, registrar: null, outcome: "failed" })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it("rejects a private connected peer before accepting an RDAP response", async () => {
    const dispatcher = fakeDispatcher()
    let connect: ReturnType<typeof createSecureConnect> | undefined
    const createDispatcher = vi.fn(
      (
        options: Parameters<
          NonNullable<RdapTransportDependencies["createDispatcher"]>
        >[0]
      ) => {
        connect = createSecureConnect({
          lookup: options.lookup,
          connectTimeoutMs: options.connectTimeoutMs,
          onConnectedAddress: options.onConnectedAddress,
          baseConnect: (_connectorOptions, callback) =>
            callback(null, {
              remoteAddress: "127.0.0.1",
              destroy: vi.fn(),
            } as never),
        })
        return dispatcher
      }
    )
    const request = vi.fn(async (url: URL) => {
      const activeConnect = connect
      if (!activeConnect) {
        throw new Error("secure connector was not installed")
      }
      await new Promise<void>((resolve, reject) => {
        activeConnect(
          {
            hostname: url.hostname,
            protocol: url.protocol,
            port: "443",
          },
          (error, _socket) => (error ? reject(error) : resolve())
        )
      })
      return jsonResponse(rdapDocument)
    })

    expect(
      await fetchDomainFacts("klu.ai", undefined, {
        createDispatcher,
        request,
      })
    ).toEqual({ expiresAt: null, registrar: null, outcome: "failed" })
    expect(request).toHaveBeenCalledOnce()
  })

  it("stops after five manually followed redirects", async () => {
    const fetcher = vi.fn<RdapFetcher>(async () => ({
      ok: false,
      status: 302,
      headers: { location: "https://registry.example/again" },
      text: async () => "",
    }))

    expect(await fetchDomainFacts("klu.ai", fetcher)).toEqual({
      expiresAt: null,
      registrar: null,
      outcome: "failed",
    })
    expect(fetcher).toHaveBeenCalledTimes(6)
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
