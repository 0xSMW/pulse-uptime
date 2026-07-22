import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import type { LookupAddress } from "node:dns"
import { Readable } from "node:stream"
import { BlockedTargetError } from "@/lib/checker/ip-policy"
import type { SecureLookup } from "@/lib/checker/secure-lookup"

import {
  type FetchResponse,
  fetchProviderDocument,
  type ManagedDispatcher,
} from "./fetch"

const SOURCE = { id: "vercel", allowedHosts: ["www.vercel-status.com"] }

function jsonBody(value: unknown): FetchResponse["body"] {
  const text = JSON.stringify(value)
  return {
    async *[Symbol.asyncIterator]() {
      yield new TextEncoder().encode(text)
    },
    destroy: vi.fn(),
  }
}

function fakeDispatcher(): ManagedDispatcher {
  return {
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as ManagedDispatcher
}

describe("fetchProviderDocument security", () => {
  it("refuses a host outside the source's allowedHosts", async () => {
    const request = vi.fn()
    await expect(
      fetchProviderDocument(
        SOURCE,
        { url: "https://evil.example/summary.json" },
        {
          request,
          createDispatcher: () => fakeDispatcher(),
        }
      )
    ).rejects.toMatchObject({ code: "BLOCKED_HOST" })
    expect(request).not.toHaveBeenCalled()
  })

  it("refuses a non-https URL", async () => {
    const request = vi.fn()
    await expect(
      fetchProviderDocument(
        SOURCE,
        { url: "http://www.vercel-status.com/summary.json" },
        {
          request,
          createDispatcher: () => fakeDispatcher(),
        }
      )
    ).rejects.toMatchObject({ code: "BLOCKED_HOST" })
  })

  it("refuses an IP literal host even when it happens to be allowlisted", async () => {
    const source = { id: "vercel", allowedHosts: ["93.184.216.34"] }
    const request = vi.fn()
    await expect(
      fetchProviderDocument(
        source,
        { url: "https://93.184.216.34/summary.json" },
        {
          request,
          createDispatcher: () => fakeDispatcher(),
        }
      )
    ).rejects.toMatchObject({ code: "BLOCKED_HOST" })
  })

  it("refuses an offsite redirect", async () => {
    const request = vi
      .fn<
        (url: URL, options: Record<string, unknown>) => Promise<FetchResponse>
      >()
      .mockResolvedValueOnce({
        statusCode: 302,
        headers: { location: "https://evil.example/summary.json" },
        body: jsonBody({}),
      })
    await expect(
      fetchProviderDocument(
        SOURCE,
        { url: "https://www.vercel-status.com/summary.json" },
        {
          request,
          createDispatcher: () => fakeDispatcher(),
        }
      )
    ).rejects.toMatchObject({ code: "BLOCKED_HOST" })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("follows an allowlisted redirect and stops after the max hop count", async () => {
    const request = vi
      .fn<
        (url: URL, options: Record<string, unknown>) => Promise<FetchResponse>
      >()
      .mockImplementation(async () => ({
        statusCode: 302,
        headers: { location: "https://www.vercel-status.com/summary.json" },
        body: jsonBody({}),
      }))
    await expect(
      fetchProviderDocument(
        SOURCE,
        { url: "https://www.vercel-status.com/summary.json" },
        {
          request,
          createDispatcher: () => fakeDispatcher(),
        }
      )
    ).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" })
    expect(request).toHaveBeenCalledTimes(4) // initial + 3 redirects
  })

  it("aborts a response larger than the 512KB cap", async () => {
    const bigChunk = new Uint8Array(600 * 1024)
    const body: FetchResponse["body"] = {
      async *[Symbol.asyncIterator]() {
        yield bigChunk
      },
      destroy: vi.fn(),
    }
    const request = vi
      .fn<
        (url: URL, options: Record<string, unknown>) => Promise<FetchResponse>
      >()
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body,
      })
    await expect(
      fetchProviderDocument(
        SOURCE,
        { url: "https://www.vercel-status.com/summary.json" },
        {
          request,
          createDispatcher: () => fakeDispatcher(),
        }
      )
    ).rejects.toMatchObject({ code: "TOO_LARGE" })
    expect(body.destroy).toHaveBeenCalled()
  })

  it("blocks a private resolved address via the connect-time lookup", async () => {
    let capturedLookup: SecureLookup | undefined
    const createDispatcher = vi.fn((options: { lookup: SecureLookup }) => {
      capturedLookup = options.lookup
      return fakeDispatcher()
    })
    const request = vi
      .fn<
        (url: URL, options: Record<string, unknown>) => Promise<FetchResponse>
      >()
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: {},
        body: jsonBody({}),
      })

    await fetchProviderDocument(
      SOURCE,
      { url: "https://www.vercel-status.com/summary.json" },
      {
        request,
        createDispatcher,
        resolveAll: async () => [
          { address: "10.0.0.5", family: 4 } as LookupAddress,
        ],
      }
    ).catch(() => undefined)

    expect(capturedLookup).toBeDefined()
    const lookup = capturedLookup
    if (!lookup) {
      throw new Error("lookup was not captured")
    }
    await new Promise<void>((resolve) => {
      lookup(
        "www.vercel-status.com",
        { all: true } as never,
        (error: unknown) => {
          expect(error).toBeInstanceOf(BlockedTargetError)
          resolve()
        }
      )
    })
  })

  it("throws INVALID_JSON on an unparsable body", async () => {
    const body: FetchResponse["body"] = {
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode("not json")
      },
      destroy: vi.fn(),
    }
    const request = vi
      .fn<
        (url: URL, options: Record<string, unknown>) => Promise<FetchResponse>
      >()
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: {},
        body,
      })
    await expect(
      fetchProviderDocument(
        SOURCE,
        { url: "https://www.vercel-status.com/summary.json" },
        {
          request,
          createDispatcher: () => fakeDispatcher(),
        }
      )
    ).rejects.toMatchObject({ code: "INVALID_JSON" })
  })
})

describe("fetchProviderDocument conditional requests", () => {
  it("sends If-None-Match and If-Modified-Since from stored validators", async () => {
    const request = vi
      .fn<
        (url: URL, options: Record<string, unknown>) => Promise<FetchResponse>
      >()
      .mockResolvedValueOnce({
        statusCode: 304,
        headers: { etag: '"v2"' },
        body: jsonBody({}),
      })
    const result = await fetchProviderDocument(
      SOURCE,
      {
        url: "https://www.vercel-status.com/summary.json",
        validators: {
          etag: '"v1"',
          lastModified: "Mon, 01 Jan 2026 00:00:00 GMT",
        },
      },
      { request, createDispatcher: () => fakeDispatcher() }
    )

    expect(result).toEqual({
      status: "not_modified",
      etag: '"v2"',
      lastModified: "Mon, 01 Jan 2026 00:00:00 GMT",
    })
    const sentHeaders = request.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >
    expect(sentHeaders["if-none-match"]).toBe('"v1"')
    expect(sentHeaders["if-modified-since"]).toBe(
      "Mon, 01 Jan 2026 00:00:00 GMT"
    )
  })

  it("returns parsed JSON with fresh cache validators on 200", async () => {
    const request = vi
      .fn<
        (url: URL, options: Record<string, unknown>) => Promise<FetchResponse>
      >()
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: {
          etag: '"v3"',
          "last-modified": "Tue, 02 Jan 2026 00:00:00 GMT",
        },
        body: jsonBody({ ok: true }),
      })
    const result = await fetchProviderDocument(
      SOURCE,
      { url: "https://www.vercel-status.com/summary.json" },
      {
        request,
        createDispatcher: () => fakeDispatcher(),
      }
    )
    expect(result).toEqual({
      status: "ok",
      statusCode: 200,
      json: { ok: true },
      etag: '"v3"',
      lastModified: "Tue, 02 Jan 2026 00:00:00 GMT",
    })
  })

  it("carries Retry-After through as a typed HTTP_STATUS error", async () => {
    const request = vi
      .fn<
        (url: URL, options: Record<string, unknown>) => Promise<FetchResponse>
      >()
      .mockResolvedValueOnce({
        statusCode: 429,
        headers: { "retry-after": "120" },
        body: jsonBody({}),
      })
    await expect(
      fetchProviderDocument(
        SOURCE,
        { url: "https://www.vercel-status.com/summary.json" },
        {
          request,
          createDispatcher: () => fakeDispatcher(),
        }
      )
    ).rejects.toMatchObject({
      code: "HTTP_STATUS",
      statusCode: 429,
      retryAfterMs: 120_000,
    })
  })

  it("caps a huge Retry-After at 24 hours", async () => {
    const request = vi
      .fn<
        (url: URL, options: Record<string, unknown>) => Promise<FetchResponse>
      >()
      .mockResolvedValueOnce({
        statusCode: 503,
        headers: { "retry-after": String(48 * 60 * 60) },
        body: jsonBody({}),
      })
    await expect(
      fetchProviderDocument(
        SOURCE,
        { url: "https://www.vercel-status.com/summary.json" },
        {
          request,
          createDispatcher: () => fakeDispatcher(),
        }
      )
    ).rejects.toMatchObject({
      code: "HTTP_STATUS",
      statusCode: 503,
      retryAfterMs: 24 * 60 * 60 * 1000,
    })
  })

  it("drops a non-finite Retry-After as null so callers use local backoff", async () => {
    const request = vi
      .fn<
        (url: URL, options: Record<string, unknown>) => Promise<FetchResponse>
      >()
      .mockResolvedValueOnce({
        statusCode: 503,
        headers: { "retry-after": "not-a-delay" },
        body: jsonBody({}),
      })
    await expect(
      fetchProviderDocument(
        SOURCE,
        { url: "https://www.vercel-status.com/summary.json" },
        {
          request,
          createDispatcher: () => fakeDispatcher(),
        }
      )
    ).rejects.toMatchObject({
      code: "HTTP_STATUS",
      statusCode: 503,
      retryAfterMs: null,
    })
  })

  it("classifies an abort/timeout error as TIMEOUT", async () => {
    const request = vi
      .fn<
        (url: URL, options: Record<string, unknown>) => Promise<FetchResponse>
      >()
      .mockRejectedValueOnce(
        Object.assign(new Error("aborted"), { name: "AbortError" })
      )
    await expect(
      fetchProviderDocument(
        SOURCE,
        { url: "https://www.vercel-status.com/summary.json" },
        {
          request,
          createDispatcher: () => fakeDispatcher(),
        }
      )
    ).rejects.toMatchObject({ code: "TIMEOUT" })
  })
})

function bytesBody(buffer: Uint8Array): FetchResponse["body"] {
  return {
    async *[Symbol.asyncIterator]() {
      yield buffer
    },
    destroy: vi.fn(),
  }
}

function respondWith(response: FetchResponse) {
  return vi
    .fn<
      (url: URL, options: Record<string, unknown>) => Promise<FetchResponse>
    >()
    .mockResolvedValueOnce(response)
}

describe("fetchProviderDocument body cap override", () => {
  it("accepts a body above the 512KB default when the source raises maxBodyBytes", async () => {
    const payload = { blob: "x".repeat(700 * 1024) }
    const request = respondWith({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: bytesBody(new TextEncoder().encode(JSON.stringify(payload))),
    })
    const source = {
      id: "aws",
      allowedHosts: ["www.vercel-status.com"],
      maxBodyBytes: 2 * 1024 * 1024,
    }
    const result = await fetchProviderDocument(
      source,
      { url: "https://www.vercel-status.com/summary.json" },
      {
        request,
        createDispatcher: () => fakeDispatcher(),
      }
    )
    expect(result).toMatchObject({ status: "ok" })
  })

  it("still rejects a body past the default when the source sets no override", async () => {
    const request = respondWith({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: bytesBody(new Uint8Array(600 * 1024)),
    })
    await expect(
      fetchProviderDocument(
        SOURCE,
        { url: "https://www.vercel-status.com/summary.json" },
        {
          request,
          createDispatcher: () => fakeDispatcher(),
        }
      )
    ).rejects.toMatchObject({ code: "TOO_LARGE" })
  })

  it("clamps an over-ceiling maxBodyBytes to 4MB rather than honoring it", async () => {
    // A 5MB body must fail even though the source asked for 8MB, since the cap is clamped to the 4MB ceiling.
    const request = respondWith({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: bytesBody(new Uint8Array(5 * 1024 * 1024)),
    })
    const source = {
      id: "aws",
      allowedHosts: ["www.vercel-status.com"],
      maxBodyBytes: 8 * 1024 * 1024,
    }
    await expect(
      fetchProviderDocument(
        source,
        { url: "https://www.vercel-status.com/summary.json" },
        {
          request,
          createDispatcher: () => fakeDispatcher(),
        }
      )
    ).rejects.toMatchObject({ code: "TOO_LARGE" })
  })
})

describe("fetchProviderDocument UTF-16 decode", () => {
  function bomLe(text: string): Uint8Array {
    return Uint8Array.from([0xff, 0xfe, ...Buffer.from(text, "utf16le")])
  }
  function bomBe(text: string): Uint8Array {
    const le = Buffer.from(text, "utf16le")
    const be = Buffer.allocUnsafe(le.length)
    for (let index = 0; index < le.length; index += 2) {
      be[index] = le[index + 1]!
      be[index + 1] = le[index]!
    }
    return Uint8Array.from([0xfe, 0xff, ...be])
  }

  it("decodes a charset=utf-16 body with a little-endian BOM before JSON.parse", async () => {
    const request = respondWith({
      statusCode: 200,
      headers: { "content-type": "application/json;charset=utf-16" },
      body: bytesBody(bomLe(JSON.stringify({ status: "ok", note: "héllo" }))),
    })
    const result = await fetchProviderDocument(
      SOURCE,
      { url: "https://www.vercel-status.com/summary.json" },
      {
        request,
        createDispatcher: () => fakeDispatcher(),
      }
    )
    expect(result).toMatchObject({
      status: "ok",
      json: { status: "ok", note: "héllo" },
    })
  })

  it("decodes a big-endian BOM body", async () => {
    const request = respondWith({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: bytesBody(bomBe(JSON.stringify({ region: "us-east-1" }))),
    })
    const result = await fetchProviderDocument(
      SOURCE,
      { url: "https://www.vercel-status.com/summary.json" },
      {
        request,
        createDispatcher: () => fakeDispatcher(),
      }
    )
    expect(result).toMatchObject({
      status: "ok",
      json: { region: "us-east-1" },
    })
  })

  it("decodes a BOM-less charset=utf-16 body from the content-type alone", async () => {
    const request = respondWith({
      statusCode: 200,
      headers: { "content-type": "application/json; charset=UTF-16LE" },
      body: bytesBody(
        Uint8Array.from(Buffer.from(JSON.stringify({ ok: true }), "utf16le"))
      ),
    })
    const result = await fetchProviderDocument(
      SOURCE,
      { url: "https://www.vercel-status.com/summary.json" },
      {
        request,
        createDispatcher: () => fakeDispatcher(),
      }
    )
    expect(result).toMatchObject({ status: "ok", json: { ok: true } })
  })
})

describe("fetchProviderDocument raw-text mode", () => {
  it("returns the decoded body as text with no JSON.parse", async () => {
    const xml = "<rss><channel><item><title>Down</title></item></channel></rss>"
    const request = respondWith({
      statusCode: 200,
      headers: { "content-type": "application/rss+xml" },
      body: bytesBody(new TextEncoder().encode(xml)),
    })
    const result = await fetchProviderDocument(
      SOURCE,
      { url: "https://www.vercel-status.com/incidents.rss", mode: "text" },
      {
        request,
        createDispatcher: () => fakeDispatcher(),
      }
    )
    expect(result).toEqual({
      status: "ok",
      statusCode: 200,
      text: xml,
      etag: null,
      lastModified: null,
    })
  })

  it("does not throw INVALID_JSON on a non-JSON body in text mode", async () => {
    const request = respondWith({
      statusCode: 200,
      headers: {},
      body: bytesBody(new TextEncoder().encode("not json at all")),
    })
    const result = await fetchProviderDocument(
      SOURCE,
      { url: "https://www.vercel-status.com/incidents.rss", mode: "text" },
      {
        request,
        createDispatcher: () => fakeDispatcher(),
      }
    )
    expect(result).toMatchObject({ status: "ok", text: "not json at all" })
  })

  it("sends a broad Accept header in text mode", async () => {
    const request = respondWith({
      statusCode: 200,
      headers: {},
      body: bytesBody(new TextEncoder().encode("<feed/>")),
    })
    await fetchProviderDocument(
      SOURCE,
      { url: "https://www.vercel-status.com/incidents.rss", mode: "text" },
      {
        request,
        createDispatcher: () => fakeDispatcher(),
      }
    )
    const sentHeaders = request.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >
    expect(sentHeaders.accept).toBe("*/*")
  })
})

describe("fetchProviderDocument connection reuse", () => {
  it("reuses a caller-supplied dispatcher across documents and never closes it", async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    const dispatcher = { close } as unknown as ManagedDispatcher
    const createDispatcher = vi.fn(() => fakeDispatcher())
    const request = vi
      .fn<
        (url: URL, options: Record<string, unknown>) => Promise<FetchResponse>
      >()
      .mockResolvedValue({
        statusCode: 200,
        headers: {},
        body: jsonBody({ ok: true }),
      })

    await fetchProviderDocument(
      SOURCE,
      { url: "https://www.vercel-status.com/a.json" },
      { request, createDispatcher, dispatcher }
    )
    await fetchProviderDocument(
      SOURCE,
      { url: "https://www.vercel-status.com/b.json" },
      { request, createDispatcher, dispatcher }
    )

    expect(request).toHaveBeenCalledTimes(2)
    expect(
      (request.mock.calls[0]![1] as { dispatcher: unknown }).dispatcher
    ).toBe(dispatcher)
    expect(
      (request.mock.calls[1]![1] as { dispatcher: unknown }).dispatcher
    ).toBe(dispatcher)
    // A supplied dispatcher means fetch neither creates its own nor closes the caller's.
    expect(createDispatcher).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it("reuses one owned dispatcher across redirect hops and closes it exactly once", async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    const dispatcher = { close } as unknown as ManagedDispatcher
    const createDispatcher = vi.fn(() => dispatcher)
    const request = vi
      .fn<
        (url: URL, options: Record<string, unknown>) => Promise<FetchResponse>
      >()
      .mockResolvedValueOnce({
        statusCode: 302,
        headers: { location: "https://www.vercel-status.com/final.json" },
        body: jsonBody({}),
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: {},
        body: jsonBody({ ok: true }),
      })

    const result = await fetchProviderDocument(
      SOURCE,
      { url: "https://www.vercel-status.com/start.json" },
      { request, createDispatcher }
    )

    expect(result).toMatchObject({ status: "ok" })
    expect(request).toHaveBeenCalledTimes(2)
    // One dispatcher spans both hops rather than one per hop.
    expect(createDispatcher).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe("fetchProviderDocument error boundary stages", () => {
  it("classifies a body-stream UND_ERR_BODY_TIMEOUT as TIMEOUT with stage body", async () => {
    const body: FetchResponse["body"] = {
      // biome-ignore lint/correctness/useYield: async-iterator mock throws before yielding to simulate a mid-stream failure
      async *[Symbol.asyncIterator]() {
        const error = Object.assign(new Error("body timeout"), {
          code: "UND_ERR_BODY_TIMEOUT",
        })
        throw error
      },
      destroy: vi.fn(),
    }
    const request = respondWith({ statusCode: 200, headers: {}, body })
    await expect(
      fetchProviderDocument(
        SOURCE,
        {
          url: "https://www.vercel-status.com/summary.json",
          documentKind: "incidents",
        },
        { request, createDispatcher: () => fakeDispatcher() }
      )
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      stage: "body",
      sourceId: "vercel",
      documentKind: "incidents",
      url: "https://www.vercel-status.com/summary.json",
    })
    expect(body.destroy).toHaveBeenCalled()
  })

  it("classifies a body-stream socket reset as NETWORK_ERROR with stage body", async () => {
    const body: FetchResponse["body"] = {
      // biome-ignore lint/correctness/useYield: async-iterator mock throws before yielding to simulate a mid-stream failure
      async *[Symbol.asyncIterator]() {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
      },
      destroy: vi.fn(),
    }
    const request = respondWith({ statusCode: 200, headers: {}, body })
    await expect(
      fetchProviderDocument(
        SOURCE,
        {
          url: "https://www.vercel-status.com/summary.json",
          documentKind: "current",
        },
        { request, createDispatcher: () => fakeDispatcher() }
      )
    ).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      stage: "body",
      sourceId: "vercel",
      documentKind: "current",
    })
    expect(body.destroy).toHaveBeenCalled()
  })

  it("classifies an aborted body stream as NETWORK_ERROR, not TIMEOUT", async () => {
    const body: FetchResponse["body"] = {
      // biome-ignore lint/correctness/useYield: async-iterator mock throws before yielding to simulate a mid-stream failure
      async *[Symbol.asyncIterator]() {
        throw Object.assign(new Error("aborted"), { name: "AbortError" })
      },
      destroy: vi.fn(),
    }
    const request = respondWith({ statusCode: 200, headers: {}, body })
    await expect(
      fetchProviderDocument(
        SOURCE,
        {
          url: "https://www.vercel-status.com/summary.json",
        },
        { request, createDispatcher: () => fakeDispatcher() }
      )
    ).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      stage: "body",
    })
    expect(body.destroy).toHaveBeenCalled()
  })

  it("tags request-establishment timeouts with stage request", async () => {
    const request = vi
      .fn<
        (url: URL, options: Record<string, unknown>) => Promise<FetchResponse>
      >()
      .mockRejectedValueOnce(
        Object.assign(new Error("headers timeout"), {
          code: "UND_ERR_HEADERS_TIMEOUT",
        })
      )
    await expect(
      fetchProviderDocument(
        SOURCE,
        {
          url: "https://www.vercel-status.com/summary.json",
          documentKind: "current",
        },
        { request, createDispatcher: () => fakeDispatcher() }
      )
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      stage: "request",
      sourceId: "vercel",
      documentKind: "current",
    })
  })

  it("tags TOO_LARGE with stage size and destroys the body", async () => {
    const body: FetchResponse["body"] = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array(600 * 1024)
      },
      destroy: vi.fn(),
    }
    const request = respondWith({ statusCode: 200, headers: {}, body })
    await expect(
      fetchProviderDocument(
        SOURCE,
        { url: "https://www.vercel-status.com/summary.json" },
        {
          request,
          createDispatcher: () => fakeDispatcher(),
        }
      )
    ).rejects.toMatchObject({
      code: "TOO_LARGE",
      stage: "size",
      sourceId: "vercel",
    })
    expect(body.destroy).toHaveBeenCalled()
  })
})

describe("fetchProviderDocument body discard safety", () => {
  it("registers an error listener before destroying a discarded 304 body", async () => {
    const on = vi.fn()
    const destroy = vi.fn()
    const body: FetchResponse["body"] = { ...jsonBody({}), on, destroy }
    const request = respondWith({
      statusCode: 304,
      headers: { etag: '"v2"' },
      body,
    })
    const result = await fetchProviderDocument(
      SOURCE,
      {
        url: "https://www.vercel-status.com/summary.json",
        validators: { etag: '"v1"', lastModified: null },
      },
      { request, createDispatcher: () => fakeDispatcher() }
    )
    expect(result.status).toBe("not_modified")
    expect(on).toHaveBeenCalledWith("error", expect.any(Function))
    expect(on.mock.invocationCallOrder[0]).toBeLessThan(
      destroy.mock.invocationCallOrder[0] ?? 0
    )
  })

  it("survives a body that errors when destroyed unconsumed, as undici bodies do", async () => {
    const stream = new Readable({
      read() {
        // A 304 body is never read, the fetch discards it.
      },
      destroy(error, callback) {
        callback(
          error ??
            Object.assign(new Error("Request aborted"), { name: "AbortError" })
        )
      },
    })
    const request = respondWith({
      statusCode: 304,
      headers: {},
      body: stream as unknown as FetchResponse["body"],
    })
    const result = await fetchProviderDocument(
      SOURCE,
      {
        url: "https://www.vercel-status.com/summary.json",
        validators: { etag: '"v1"', lastModified: null },
      },
      { request, createDispatcher: () => fakeDispatcher() }
    )
    expect(result.status).toBe("not_modified")
    // Flush the destroy callback tick. Without the listener registered by
    // destroyBody, this emits an unhandled AbortError that fails the run.
    await new Promise((resolve) => setImmediate(resolve))
    expect(stream.destroyed).toBe(true)
  })
})

describe("fetchProviderDocument caller-controlled deadlines", () => {
  it("uses min(standard timeout, caller timeoutMs) as the request budget", async () => {
    const request = respondWith({
      statusCode: 200,
      headers: {},
      body: jsonBody({ ok: true }),
    })
    await fetchProviderDocument(
      SOURCE,
      {
        url: "https://www.vercel-status.com/summary.json",
        timeoutMs: 1500,
      },
      { request, createDispatcher: () => fakeDispatcher(), now: () => 0 }
    )

    const options = request.mock.calls[0]?.[1] as {
      headersTimeout: number
      bodyTimeout: number
    }
    expect(options.headersTimeout).toBe(1500)
    expect(options.bodyTimeout).toBe(1500)
  })

  it("uses remaining deadlineAtMs budget when tighter than the standard timeout", async () => {
    const clock = 1000
    const request = respondWith({
      statusCode: 200,
      headers: {},
      body: jsonBody({ ok: true }),
    })
    await fetchProviderDocument(
      SOURCE,
      {
        url: "https://www.vercel-status.com/summary.json",
        deadlineAtMs: 1000 + 800,
      },
      { request, createDispatcher: () => fakeDispatcher(), now: () => clock }
    )

    const options = request.mock.calls[0]?.[1] as {
      headersTimeout: number
      bodyTimeout: number
    }
    expect(options.headersTimeout).toBe(800)
    expect(options.bodyTimeout).toBe(800)
  })

  it("rejects before opening the request when remaining budget is below the safety threshold", async () => {
    const request = vi.fn()
    await expect(
      fetchProviderDocument(
        SOURCE,
        {
          url: "https://www.vercel-status.com/summary.json",
          deadlineAtMs: 1010,
        },
        {
          request,
          createDispatcher: () => fakeDispatcher(),
          now: () => 1000,
        }
      )
    ).rejects.toMatchObject({ code: "TIMEOUT", stage: "request" })
    expect(request).not.toHaveBeenCalled()
  })

  it("rejects when timeoutMs is already exhausted before the request opens", async () => {
    const request = vi.fn()
    await expect(
      fetchProviderDocument(
        SOURCE,
        {
          url: "https://www.vercel-status.com/summary.json",
          timeoutMs: 0,
        },
        { request, createDispatcher: () => fakeDispatcher() }
      )
    ).rejects.toMatchObject({ code: "TIMEOUT" })
    expect(request).not.toHaveBeenCalled()
  })
})

describe("fetchProviderDocument UTF-8 BOM", () => {
  it("strips a UTF-8 BOM so JSON.parse receives a clean string", async () => {
    const payload = JSON.stringify({ status: "ok", note: "bom" })
    const withBom = Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(payload),
    ])
    const request = respondWith({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: bytesBody(withBom),
    })
    const result = await fetchProviderDocument(
      SOURCE,
      { url: "https://www.vercel-status.com/summary.json" },
      {
        request,
        createDispatcher: () => fakeDispatcher(),
      }
    )
    expect(result).toMatchObject({
      status: "ok",
      json: { status: "ok", note: "bom" },
    })
  })

  it("strips a UTF-8 BOM in text mode", async () => {
    const xml = "<rss><channel></channel></rss>"
    const withBom = Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(xml),
    ])
    const request = respondWith({
      statusCode: 200,
      headers: { "content-type": "application/rss+xml" },
      body: bytesBody(withBom),
    })
    const result = await fetchProviderDocument(
      SOURCE,
      {
        url: "https://www.vercel-status.com/incidents.rss",
        mode: "text",
      },
      { request, createDispatcher: () => fakeDispatcher() }
    )
    expect(result).toMatchObject({ status: "ok", text: xml })
    if (result.status === "ok") {
      expect(result.text?.charCodeAt(0)).not.toBe(0xfe_ff)
    }
  })
})
