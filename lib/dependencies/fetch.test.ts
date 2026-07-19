import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { BlockedTargetError } from "@/lib/checker/ip-policy";
import type { SecureLookup } from "@/lib/checker/secure-lookup";
import type { LookupAddress } from "node:dns";

import { fetchProviderDocument, type FetchResponse, type ManagedDispatcher } from "./fetch";

const SOURCE = { id: "vercel", allowedHosts: ["www.vercel-status.com"] };

function jsonBody(value: unknown): FetchResponse["body"] {
  const text = JSON.stringify(value);
  return {
    async *[Symbol.asyncIterator]() {
      yield new TextEncoder().encode(text);
    },
    destroy: vi.fn(),
  };
}

function fakeDispatcher(): ManagedDispatcher {
  return { close: vi.fn().mockResolvedValue(undefined) } as unknown as ManagedDispatcher;
}

describe("fetchProviderDocument security", () => {
  it("refuses a host outside the source's allowedHosts", async () => {
    const request = vi.fn();
    await expect(fetchProviderDocument(SOURCE, { url: "https://evil.example/summary.json" }, {
      request, createDispatcher: () => fakeDispatcher(),
    })).rejects.toMatchObject({ code: "BLOCKED_HOST" });
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a non-https URL", async () => {
    const request = vi.fn();
    await expect(fetchProviderDocument(SOURCE, { url: "http://www.vercel-status.com/summary.json" }, {
      request, createDispatcher: () => fakeDispatcher(),
    })).rejects.toMatchObject({ code: "BLOCKED_HOST" });
  });

  it("refuses an IP literal host even when it happens to be allowlisted", async () => {
    const source = { id: "vercel", allowedHosts: ["93.184.216.34"] };
    const request = vi.fn();
    await expect(fetchProviderDocument(source, { url: "https://93.184.216.34/summary.json" }, {
      request, createDispatcher: () => fakeDispatcher(),
    })).rejects.toMatchObject({ code: "BLOCKED_HOST" });
  });

  it("refuses an offsite redirect", async () => {
    const request = vi.fn<(url: URL, options: Record<string, unknown>) => Promise<FetchResponse>>()
      .mockResolvedValueOnce({
        statusCode: 302,
        headers: { location: "https://evil.example/summary.json" },
        body: jsonBody({}),
      });
    await expect(fetchProviderDocument(SOURCE, { url: "https://www.vercel-status.com/summary.json" }, {
      request, createDispatcher: () => fakeDispatcher(),
    })).rejects.toMatchObject({ code: "BLOCKED_HOST" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("follows an allowlisted redirect and stops after the max hop count", async () => {
    const request = vi.fn<(url: URL, options: Record<string, unknown>) => Promise<FetchResponse>>().mockImplementation(async () => ({
      statusCode: 302,
      headers: { location: "https://www.vercel-status.com/summary.json" },
      body: jsonBody({}),
    }));
    await expect(fetchProviderDocument(SOURCE, { url: "https://www.vercel-status.com/summary.json" }, {
      request, createDispatcher: () => fakeDispatcher(),
    })).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
    expect(request).toHaveBeenCalledTimes(4); // initial + 3 redirects
  });

  it("aborts a response larger than the 512KB cap", async () => {
    const bigChunk = new Uint8Array(600 * 1024);
    const body: FetchResponse["body"] = {
      async *[Symbol.asyncIterator]() {
        yield bigChunk;
      },
      destroy: vi.fn(),
    };
    const request = vi.fn<(url: URL, options: Record<string, unknown>) => Promise<FetchResponse>>().mockResolvedValueOnce({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body,
    });
    await expect(fetchProviderDocument(SOURCE, { url: "https://www.vercel-status.com/summary.json" }, {
      request, createDispatcher: () => fakeDispatcher(),
    })).rejects.toMatchObject({ code: "TOO_LARGE" });
    expect(body.destroy).toHaveBeenCalled();
  });

  it("blocks a private resolved address via the connect-time lookup", async () => {
    let capturedLookup: SecureLookup | undefined;
    const createDispatcher = vi.fn((options: { lookup: SecureLookup }) => {
      capturedLookup = options.lookup;
      return fakeDispatcher();
    });
    const request = vi.fn<(url: URL, options: Record<string, unknown>) => Promise<FetchResponse>>().mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: jsonBody({}),
    });

    await fetchProviderDocument(SOURCE, { url: "https://www.vercel-status.com/summary.json" }, {
      request,
      createDispatcher,
      resolveAll: async () => [{ address: "10.0.0.5", family: 4 } as LookupAddress],
    }).catch(() => undefined);

    expect(capturedLookup).toBeDefined();
    const lookup = capturedLookup;
    if (!lookup) throw new Error("lookup was not captured");
    await new Promise<void>((resolve) => {
      lookup("www.vercel-status.com", { all: true } as never, (error: unknown) => {
        expect(error).toBeInstanceOf(BlockedTargetError);
        resolve();
      });
    });
  });

  it("throws INVALID_JSON on an unparsable body", async () => {
    const body: FetchResponse["body"] = {
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode("not json");
      },
      destroy: vi.fn(),
    };
    const request = vi.fn<(url: URL, options: Record<string, unknown>) => Promise<FetchResponse>>().mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body,
    });
    await expect(fetchProviderDocument(SOURCE, { url: "https://www.vercel-status.com/summary.json" }, {
      request, createDispatcher: () => fakeDispatcher(),
    })).rejects.toMatchObject({ code: "INVALID_JSON" });
  });
});

describe("fetchProviderDocument conditional requests", () => {
  it("sends If-None-Match and If-Modified-Since from stored validators", async () => {
    const request = vi.fn<(url: URL, options: Record<string, unknown>) => Promise<FetchResponse>>().mockResolvedValueOnce({
      statusCode: 304,
      headers: { etag: "\"v2\"" },
      body: jsonBody({}),
    });
    const result = await fetchProviderDocument(SOURCE, {
      url: "https://www.vercel-status.com/summary.json",
      validators: { etag: "\"v1\"", lastModified: "Mon, 01 Jan 2026 00:00:00 GMT" },
    }, { request, createDispatcher: () => fakeDispatcher() });

    expect(result).toEqual({ status: "not_modified", etag: "\"v2\"", lastModified: "Mon, 01 Jan 2026 00:00:00 GMT" });
    const sentHeaders = request.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(sentHeaders["if-none-match"]).toBe("\"v1\"");
    expect(sentHeaders["if-modified-since"]).toBe("Mon, 01 Jan 2026 00:00:00 GMT");
  });

  it("returns parsed JSON with fresh cache validators on 200", async () => {
    const request = vi.fn<(url: URL, options: Record<string, unknown>) => Promise<FetchResponse>>().mockResolvedValueOnce({
      statusCode: 200,
      headers: { etag: "\"v3\"", "last-modified": "Tue, 02 Jan 2026 00:00:00 GMT" },
      body: jsonBody({ ok: true }),
    });
    const result = await fetchProviderDocument(SOURCE, { url: "https://www.vercel-status.com/summary.json" }, {
      request, createDispatcher: () => fakeDispatcher(),
    });
    expect(result).toEqual({ status: "ok", statusCode: 200, json: { ok: true }, etag: "\"v3\"", lastModified: "Tue, 02 Jan 2026 00:00:00 GMT" });
  });

  it("carries Retry-After through as a typed HTTP_STATUS error", async () => {
    const request = vi.fn<(url: URL, options: Record<string, unknown>) => Promise<FetchResponse>>().mockResolvedValueOnce({
      statusCode: 429,
      headers: { "retry-after": "120" },
      body: jsonBody({}),
    });
    await expect(fetchProviderDocument(SOURCE, { url: "https://www.vercel-status.com/summary.json" }, {
      request, createDispatcher: () => fakeDispatcher(),
    })).rejects.toMatchObject({ code: "HTTP_STATUS", statusCode: 429, retryAfterMs: 120_000 });
  });

  it("classifies an abort/timeout error as TIMEOUT", async () => {
    const request = vi.fn<(url: URL, options: Record<string, unknown>) => Promise<FetchResponse>>().mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await expect(fetchProviderDocument(SOURCE, { url: "https://www.vercel-status.com/summary.json" }, {
      request, createDispatcher: () => fakeDispatcher(),
    })).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});
