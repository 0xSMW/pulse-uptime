import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const { fetchProviderDocument } = vi.hoisted(() => ({
  fetchProviderDocument: vi.fn(),
}))
vi.mock("./fetch", () => ({
  fetchProviderDocument,
  // Per-source collection opens a dispatcher for keep-alive reuse. Tests never
  // hit the network, so a stub close is enough.
  createProviderDispatcher: () => ({ close: vi.fn(async () => undefined) }),
}))

import auth0Operational from "./adapters/fixtures/auth0/operational.json"
import awsOperational from "./adapters/fixtures/aws/operational.json"
import { createLiveCatalogDirectoryFetcher } from "./catalog-revalidation"
import { MAX_CATALOG_DOCUMENTS_PER_SOURCE } from "./document-collector"
import { loadCatalogManifest } from "./manifest"

const manifest = loadCatalogManifest()
const fixturesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "adapters",
  "fixtures"
)
const readFixture = (provider: string, name: string): string =>
  readFileSync(join(fixturesRoot, provider, name), "utf8")

/** Wraps an Auth0 __NEXT_DATA__ payload the same way the adapter tests do. */
function auth0Html(payload: unknown): string {
  return `<!doctype html><html><head><title>Auth0 Status</title></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></body></html>`
}

beforeEach(() => {
  fetchProviderDocument.mockReset()
})

describe("createLiveCatalogDirectoryFetcher", () => {
  it("returns null for a source no longer present in the manifest", async () => {
    const fetcher = createLiveCatalogDirectoryFetcher(manifest)
    const result = await fetcher({
      source: {
        id: "not-a-real-source",
        adapter: "statuspage_v2",
        currentUrl: "https://example.com",
      },
    })
    expect(result).toBeNull()
    expect(fetchProviderDocument).not.toHaveBeenCalled()
  })

  it("fetches Google Cloud's products.json with the source host allowlist and body policy, in JSON mode", async () => {
    fetchProviderDocument.mockResolvedValueOnce({
      status: "ok",
      statusCode: 200,
      json: {
        products: [
          { id: "prod-1", title: "Cloud Run" },
          { id: "prod-2", title: "Cloud SQL" },
        ],
      },
      etag: null,
      lastModified: null,
    })
    const fetcher = createLiveCatalogDirectoryFetcher(manifest)
    const source = manifest.sources.find(
      (entry) => entry.id === "google_cloud"
    )!
    const result = await fetcher({
      source: {
        id: source.id,
        adapter: source.adapter,
        currentUrl: source.currentUrl,
      },
    })

    expect(result?.componentIds).toEqual(new Set(["prod-1", "prod-2"]))
    expect(result?.complete).toBe(true)
    expect(fetchProviderDocument).toHaveBeenCalledTimes(1)
    const [providerSource, request] = fetchProviderDocument.mock.calls[0]!
    expect(request.url).toBe(source.config.productsUrl)
    expect(request.mode).toBe("json")
    expect(request.documentKind).toBe("current")
    expect(providerSource).toEqual({
      id: source.id,
      allowedHosts: source.allowedHosts,
      maxBodyBytes: undefined,
    })
  })

  it("also collects Google product ids from a bare top-level array", async () => {
    fetchProviderDocument.mockResolvedValueOnce({
      status: "ok",
      statusCode: 200,
      json: [
        { id: "prod-1", title: "Cloud Run" },
        { id: "prod-2", title: "Cloud SQL" },
      ],
      etag: null,
      lastModified: null,
    })
    const fetcher = createLiveCatalogDirectoryFetcher(manifest)
    const source = manifest.sources.find(
      (entry) => entry.id === "google_cloud"
    )!
    const result = await fetcher({
      source: {
        id: source.id,
        adapter: source.adapter,
        currentUrl: source.currentUrl,
      },
    })

    expect(result?.componentIds).toEqual(new Set(["prod-1", "prod-2"]))
    expect(result?.complete).toBe(true)
  })

  it("returns null when Google's products response is not modified", async () => {
    fetchProviderDocument.mockResolvedValueOnce({
      status: "not_modified",
      etag: null,
      lastModified: null,
    })
    const fetcher = createLiveCatalogDirectoryFetcher(manifest)
    const source = manifest.sources.find(
      (entry) => entry.id === "google_cloud"
    )!
    const result = await fetcher({
      source: {
        id: source.id,
        adapter: source.adapter,
        currentUrl: source.currentUrl,
      },
    })
    expect(result).toBeNull()
  })

  it("returns null when Google's products response carries no products array", async () => {
    fetchProviderDocument.mockResolvedValueOnce({
      status: "ok",
      statusCode: 200,
      json: { error: "unavailable" },
      etag: null,
      lastModified: null,
    })
    const fetcher = createLiveCatalogDirectoryFetcher(manifest)
    const source = manifest.sources.find(
      (entry) => entry.id === "google_cloud"
    )!
    const result = await fetcher({
      source: {
        id: source.id,
        adapter: source.adapter,
        currentUrl: source.currentUrl,
      },
    })
    expect(result).toBeNull()
  })

  it("fetches only current-kind documents for a statuspage_v2 source and reports component ids from normalize", async () => {
    fetchProviderDocument.mockResolvedValueOnce({
      status: "ok",
      statusCode: 200,
      json: {
        page: { id: "p1", updated_at: "2026-07-19T12:00:00Z" },
        status: { indicator: "none", description: "All Systems Operational" },
        components: [{ id: "comp-1", name: "API", status: "operational" }],
        incidents: [],
        scheduled_maintenances: [],
      },
      etag: '"v1"',
      lastModified: null,
    })
    const fetcher = createLiveCatalogDirectoryFetcher(manifest)
    const source = manifest.sources.find((entry) => entry.id === "anthropic")!
    const result = await fetcher({
      source: {
        id: source.id,
        adapter: source.adapter,
        currentUrl: source.currentUrl,
      },
    })

    expect(result?.componentIds).toEqual(new Set(["comp-1"]))
    expect(result?.complete).toBe(true)
    // Only the primary summary document is fetched: no incidents.json, no maintenance route.
    expect(fetchProviderDocument).toHaveBeenCalledTimes(1)
    const [, request] = fetchProviderDocument.mock.calls[0]!
    expect(request.url).toBe(source.currentUrl)
  })

  it("returns null and records no drift when the live fetch fails", async () => {
    fetchProviderDocument.mockRejectedValueOnce(new Error("network down"))
    const fetcher = createLiveCatalogDirectoryFetcher(manifest)
    const source = manifest.sources.find((entry) => entry.id === "anthropic")!
    const result = await fetcher({
      source: {
        id: source.id,
        adapter: source.adapter,
        currentUrl: source.currentUrl,
      },
    })
    expect(result).toBeNull()
  })

  it("Auth0: revalidation fetches current in text mode with the configured 2MB body cap", async () => {
    const source = manifest.sources.find((entry) => entry.id === "auth0")!
    fetchProviderDocument.mockResolvedValueOnce({
      status: "ok",
      statusCode: 200,
      text: auth0Html(auth0Operational),
      etag: null,
      lastModified: null,
    })
    const fetcher = createLiveCatalogDirectoryFetcher(manifest)
    const result = await fetcher({
      source: {
        id: source.id,
        adapter: source.adapter,
        currentUrl: source.currentUrl,
      },
    })

    expect(result).not.toBeNull()
    expect(result!.componentIds.has("US-1")).toBe(true)
    expect(result!.componentIds.has("EU-1")).toBe(true)
    expect(fetchProviderDocument).toHaveBeenCalledTimes(1)
    const [providerSource, request] = fetchProviderDocument.mock.calls[0]!
    expect(request).toMatchObject({
      url: source.currentUrl,
      mode: "text",
      documentKind: "current",
    })
    expect(providerSource).toEqual({
      id: "auth0",
      allowedHosts: source.allowedHosts,
      maxBodyBytes: 2 * 1024 * 1024,
    })
  })

  it("Hetzner: HTML text mode with the source 1MB body cap, then normalizes component ids", async () => {
    const source = manifest.sources.find((entry) => entry.id === "hetzner")!
    fetchProviderDocument.mockResolvedValueOnce({
      status: "ok",
      statusCode: 200,
      text: readFixture("hetzner", "operational.html"),
      etag: null,
      lastModified: null,
    })
    const fetcher = createLiveCatalogDirectoryFetcher(manifest)
    const result = await fetcher({
      source: {
        id: source.id,
        adapter: source.adapter,
        currentUrl: source.currentUrl,
      },
    })

    expect(result).not.toBeNull()
    // Catalog presets pin these integer system ids.
    for (const id of ["3", "91", "6", "78"]) {
      expect(result!.componentIds.has(id)).toBe(true)
    }
    const [providerSource, request] = fetchProviderDocument.mock.calls[0]!
    expect(request).toMatchObject({
      url: source.currentUrl,
      mode: "text",
      documentKind: "current",
    })
    expect(providerSource).toEqual({
      id: "hetzner",
      allowedHosts: ["status.hetzner.com"],
      maxBodyBytes: 1024 * 1024,
    })
  })

  it("incident feed: fetches decoded text and can normalize without persistence", async () => {
    const source = manifest.sources.find((entry) => entry.id === "openrouter")!
    fetchProviderDocument.mockResolvedValueOnce({
      status: "ok",
      statusCode: 200,
      text: readFixture("openrouter", "empty.rss"),
      etag: null,
      lastModified: null,
    })
    const fetcher = createLiveCatalogDirectoryFetcher(manifest)
    const result = await fetcher({
      source: {
        id: source.id,
        adapter: source.adapter,
        currentUrl: source.currentUrl,
      },
    })

    // Incident-only feeds expose no component ids; success is a non-null empty set.
    expect(result?.componentIds).toEqual(new Set())
    expect(result?.complete).toBe(true)
    const [providerSource, request] = fetchProviderDocument.mock.calls[0]!
    expect(request).toMatchObject({
      url: source.currentUrl,
      mode: "text",
      documentKind: "current",
    })
    expect(providerSource).toEqual({
      id: "openrouter",
      allowedHosts: source.allowedHosts,
      maxBodyBytes: undefined,
    })
  })

  it("AWS: revalidation uses the 2MB source cap and JSON mode", async () => {
    const source = manifest.sources.find((entry) => entry.id === "aws")!
    fetchProviderDocument.mockResolvedValueOnce({
      status: "ok",
      statusCode: 200,
      json: awsOperational,
      etag: null,
      lastModified: null,
    })
    const fetcher = createLiveCatalogDirectoryFetcher(manifest)
    const result = await fetcher({
      source: {
        id: source.id,
        adapter: source.adapter,
        currentUrl: source.currentUrl,
      },
    })

    // Active-only feed: empty currentevents means no components in the map.
    expect(result?.componentIds).toEqual(new Set())
    expect(result?.complete).toBe(true)
    const [providerSource, request] = fetchProviderDocument.mock.calls[0]!
    expect(request).toMatchObject({
      url: source.currentUrl,
      documentKind: "current",
    })
    // AWS requests omit mode, so fetch defaults to JSON (undefined is fine).
    expect(request.mode).toBeUndefined()
    expect(providerSource).toEqual({
      id: "aws",
      allowedHosts: ["health.aws.amazon.com"],
      maxBodyBytes: 2 * 1024 * 1024,
    })
  })

  it("paginated current adapter: follow-ups preserve mode and only fetch current pages", async () => {
    const source = manifest.sources.find((entry) => entry.id === "postmark")!
    const componentsUrl = source.config.componentsUrl as string
    fetchProviderDocument
      .mockResolvedValueOnce({
        status: "ok",
        statusCode: 200,
        json: {
          components: [{ id: 1, name: "API", state: "operational" }],
          meta: {
            count: 1,
            total_count: 2,
            next_page: "/api/v1/components?page=2",
          },
        },
        etag: null,
        lastModified: null,
      })
      .mockResolvedValueOnce({
        status: "ok",
        statusCode: 200,
        json: {
          components: [{ id: 2, name: "SMTP", state: "degraded" }],
          meta: { count: 1, total_count: 2, next_page: null },
        },
        etag: null,
        lastModified: null,
      })
    const fetcher = createLiveCatalogDirectoryFetcher(manifest)
    const result = await fetcher({
      source: {
        id: source.id,
        adapter: source.adapter,
        currentUrl: source.currentUrl,
      },
    })

    expect(result?.componentIds).toEqual(new Set(["1", "2"]))
    expect(result?.complete).toBe(true)
    expect(fetchProviderDocument).toHaveBeenCalledTimes(2)
    const urls = fetchProviderDocument.mock.calls.map((call) => call[1].url)
    expect(urls[0]).toBe(componentsUrl)
    expect(urls[1]).toContain("page=2")
    // Both pages keep the adapter's mode (json default for sorry_v1 current).
    for (const call of fetchProviderDocument.mock.calls) {
      expect(call[1].documentKind).toBe("current")
      // sorry_v1 does not set mode, so undefined means the fetch JSON default.
      expect(call[1].mode).toBeUndefined()
      expect(call[0]).toEqual({
        id: "postmark",
        allowedHosts: source.allowedHosts,
        maxBodyBytes: undefined,
      })
    }
  })

  it("excessive follow-ups stop at the document budget and report failure as null", async () => {
    const source = manifest.sources.find((entry) => entry.id === "postmark")!
    const componentsUrl = source.config.componentsUrl as string
    let componentsPage = 0
    fetchProviderDocument.mockImplementation(
      async (_providerSource: unknown, request: { url: string }) => {
        if (
          request.url === componentsUrl ||
          request.url.startsWith(`${componentsUrl}?`)
        ) {
          componentsPage += 1
          return {
            status: "ok" as const,
            statusCode: 200,
            json: {
              components: [
                { id: 1, name: "API", state: "operational", updated_at: null },
              ],
              meta: {
                count: 1,
                total_count: 999_999,
                next_page: `${componentsUrl}?cursor=${componentsPage}`,
              },
            },
            etag: null,
            lastModified: null,
          }
        }
        throw new Error(`unexpected url ${request.url}`)
      }
    )

    const fetcher = createLiveCatalogDirectoryFetcher(manifest)
    const result = await fetcher({
      source: {
        id: source.id,
        adapter: source.adapter,
        currentUrl: source.currentUrl,
      },
    })

    // Budget exceeded is a failed live validation: no drift, no component set.
    expect(result).toBeNull()
    expect(fetchProviderDocument).toHaveBeenCalledTimes(
      MAX_CATALOG_DOCUMENTS_PER_SOURCE
    )
  })

  it("forwards deadlineAtMs into live fetches so slow pages clamp to remaining budget", async () => {
    fetchProviderDocument.mockResolvedValueOnce({
      status: "ok",
      statusCode: 200,
      json: {
        page: { id: "p1", updated_at: "2026-07-19T12:00:00Z" },
        status: { indicator: "none", description: "All Systems Operational" },
        components: [{ id: "comp-1", name: "API", status: "operational" }],
        incidents: [],
        scheduled_maintenances: [],
      },
      etag: null,
      lastModified: null,
    })
    const fetcher = createLiveCatalogDirectoryFetcher(manifest)
    const source = manifest.sources.find((entry) => entry.id === "anthropic")!
    await fetcher({
      source: {
        id: source.id,
        adapter: source.adapter,
        currentUrl: source.currentUrl,
      },
      deadlineAtMs: 1_234_567,
      nowMs: () => 1000,
    })
    const [, request] = fetchProviderDocument.mock.calls[0]!
    expect(request.deadlineAtMs).toBe(1_234_567)
  })

  it("returns null without partial directory data when the deadline is already spent", async () => {
    const source = manifest.sources.find((entry) => entry.id === "postmark")!
    const fetcher = createLiveCatalogDirectoryFetcher(manifest)
    const result = await fetcher({
      source: {
        id: source.id,
        adapter: source.adapter,
        currentUrl: source.currentUrl,
      },
      deadlineAtMs: 100,
      nowMs: () => 100,
    })
    expect(result).toBeNull()
    expect(fetchProviderDocument).not.toHaveBeenCalled()
  })
})
