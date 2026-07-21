import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import type { AdapterDocument, DependencyAdapter } from "./adapters"
import {
  collectAdapterDocuments,
  MAX_CATALOG_DOCUMENTS_PER_SOURCE,
  MAX_DOCUMENTS_PER_CYCLE,
} from "./document-collector"
import { ProviderFetchError } from "./fetch"
import type { DependencySourceManifest } from "./manifest"

const source: DependencySourceManifest = {
  id: "example",
  provider: "Example",
  adapter: "statuspage_v2",
  currentUrl: "https://status.example.com/summary.json",
  incidentsUrl: "https://status.example.com/incidents.json",
  statusPageUrl: "https://status.example.com",
  allowedHosts: ["status.example.com"],
  operationalPollSeconds: 300,
  activePollSeconds: 60,
  staleAfterSeconds: 900,
  config: {},
}

function okJson(json: unknown = {}) {
  return {
    status: "ok" as const,
    statusCode: 200,
    json,
    etag: null as string | null,
    lastModified: null as string | null,
  }
}

/** Adapter that emits a fresh unique next page forever. */
function endlessPaginationAdapter(): Pick<DependencyAdapter, "requests"> {
  return {
    requests(_source, fetchedSoFar) {
      const pages = (fetchedSoFar ?? []).filter((doc) => doc.kind === "current")
      const next = pages.length + 1
      return [
        {
          kind: "current",
          url: `https://status.example.com/page/${next}`,
          optional: false,
        },
      ]
    },
  }
}

describe("collectAdapterDocuments", () => {
  it("stops endless unique pagination at the document cap with an incomplete result", async () => {
    const fetchDocument = vi.fn(async () => okJson({ page: true }))
    const result = await collectAdapterDocuments({
      adapter: endlessPaginationAdapter(),
      source,
      maxDocuments: 5,
      fetchDocument,
    })

    expect(result.status).toBe("incomplete")
    if (result.status === "incomplete") {
      expect(result.reason).toBe("document_cap")
      expect(result.fetchedCount).toBe(5)
      expect(result.documents).toHaveLength(5)
    }
    // Cap check is before fetch: exactly maxDocuments network calls, never more.
    expect(fetchDocument).toHaveBeenCalledTimes(5)
  })

  it("returns incomplete when the deadline is already spent before a request", async () => {
    const fetchDocument = vi.fn(async () => okJson())
    const clock = 1000
    const result = await collectAdapterDocuments({
      adapter: endlessPaginationAdapter(),
      source,
      maxDocuments: 50,
      deadlineAtMs: 1000,
      nowMs: () => clock,
      fetchDocument,
    })

    expect(result).toMatchObject({
      status: "incomplete",
      reason: "deadline",
      fetchedCount: 0,
    })
    expect(fetchDocument).not.toHaveBeenCalled()
    // Clock unused for the deadline-hit path; keep the binding live for clarity.
    expect(clock).toBe(1000)
  })

  it("forwards deadlineAtMs into every fetch so timeouts clamp to remaining budget", async () => {
    const fetchDocument = vi.fn(async () => okJson())
    const adapter: Pick<DependencyAdapter, "requests"> = {
      requests() {
        return [{ kind: "current", url: source.currentUrl, optional: false }]
      },
    }
    await collectAdapterDocuments({
      adapter,
      source,
      maxDocuments: 10,
      deadlineAtMs: 50_000,
      nowMs: () => 40_000,
      fetchDocument,
    })

    expect(fetchDocument).toHaveBeenCalledWith(
      expect.objectContaining({ url: source.currentUrl }),
      expect.objectContaining({ deadlineAtMs: 50_000 })
    )
  })

  it("filters to allowedKinds so catalog collection never pulls incidents", async () => {
    const urls: string[] = []
    const adapter: Pick<DependencyAdapter, "requests"> = {
      requests() {
        return [
          { kind: "current", url: source.currentUrl, optional: false },
          { kind: "incidents", url: source.incidentsUrl!, optional: true },
          {
            kind: "maintenance",
            url: "https://status.example.com/maint.json",
            optional: true,
          },
        ]
      },
    }
    const result = await collectAdapterDocuments({
      adapter,
      source,
      allowedKinds: ["current"],
      maxDocuments: MAX_CATALOG_DOCUMENTS_PER_SOURCE,
      fetchDocument: async (request) => {
        urls.push(request.url)
        return okJson({ components: [] })
      },
    })

    expect(result.status).toBe("complete")
    expect(urls).toEqual([source.currentUrl])
  })

  it("skips optional ProviderFetchError when skipOptionalFetchErrors is set", async () => {
    const adapter: Pick<DependencyAdapter, "requests"> = {
      requests() {
        return [
          { kind: "current", url: source.currentUrl, optional: false },
          { kind: "incidents", url: source.incidentsUrl!, optional: true },
        ]
      },
    }
    const result = await collectAdapterDocuments({
      adapter,
      source,
      maxDocuments: 10,
      skipOptionalFetchErrors: true,
      fetchDocument: async (request) => {
        if (request.kind === "incidents") {
          throw new ProviderFetchError("TIMEOUT", "timeout", null, null, {
            sourceId: source.id,
            url: request.url,
          })
        }
        return okJson({ ok: true })
      },
    })

    expect(result.status).toBe("complete")
    if (result.status === "complete") {
      expect(result.documents).toHaveLength(1)
      expect(result.documents[0]!.url).toBe(source.currentUrl)
    }
  })

  it("propagates required-document fetch failures", async () => {
    const adapter: Pick<DependencyAdapter, "requests"> = {
      requests() {
        return [{ kind: "current", url: source.currentUrl, optional: false }]
      },
    }
    await expect(
      collectAdapterDocuments({
        adapter,
        source,
        maxDocuments: 10,
        skipOptionalFetchErrors: true,
        fetchDocument: async (request) => {
          throw new ProviderFetchError("TIMEOUT", "timeout", null, null, {
            sourceId: source.id,
            url: request.url,
          })
        },
      })
    ).rejects.toBeInstanceOf(ProviderFetchError)
  })

  it("short-circuits on primary 304 when primaryStandsAlone is true", async () => {
    const adapter: Pick<DependencyAdapter, "requests"> = {
      requests() {
        return [
          { kind: "current", url: source.currentUrl, optional: false },
          { kind: "incidents", url: source.incidentsUrl!, optional: true },
        ]
      },
    }
    const fetchDocument = vi.fn(async () => ({
      status: "not_modified" as const,
      etag: '"v1"',
      lastModified: null,
    }))
    const result = await collectAdapterDocuments({
      adapter,
      source,
      maxDocuments: 10,
      primaryStandsAlone: true,
      primaryValidators: { etag: '"v1"', lastModified: null },
      fetchDocument,
    })

    expect(result).toEqual({
      status: "not_modified",
      etag: '"v1"',
      lastModified: null,
    })
    expect(fetchDocument).toHaveBeenCalledTimes(1)
    const firstCall = fetchDocument.mock.calls[0] as unknown as [
      { url: string },
      { validators?: { etag: string | null; lastModified: string | null } },
    ]
    expect(firstCall[1]).toMatchObject({
      validators: { etag: '"v1"', lastModified: null },
    })
  })

  it("skips a non-primary url that answers 304 instead of re-issuing it to the cap", async () => {
    const adapter: Pick<DependencyAdapter, "requests"> = {
      requests() {
        return [
          { kind: "current", url: source.currentUrl, optional: false },
          { kind: "incidents", url: source.incidentsUrl!, optional: true },
        ]
      },
    }
    // No conditional validators are sent for the incidents url, so a 304 there
    // is a misbehaving server. The collector must not loop on it.
    const fetchDocument = vi.fn(async (request: { url: string }) =>
      request.url === source.incidentsUrl
        ? { status: "not_modified" as const, etag: null, lastModified: null }
        : okJson({ page: true })
    )
    const result = await collectAdapterDocuments({
      adapter,
      source,
      maxDocuments: 10,
      fetchDocument,
    })

    expect(result.status).toBe("complete")
    expect(fetchDocument).toHaveBeenCalledTimes(2)
  })

  it("seeds from initialDocuments and does not re-fetch those URLs", async () => {
    const initial: AdapterDocument[] = [
      {
        kind: "current",
        url: source.currentUrl,
        json: { page: 1 },
      },
    ]
    const adapter: Pick<DependencyAdapter, "requests"> = {
      requests(_source, fetchedSoFar) {
        if (!fetchedSoFar?.length) {
          return [{ kind: "current", url: source.currentUrl, optional: false }]
        }
        return [
          {
            kind: "current",
            url: "https://status.example.com/page/2",
            optional: false,
          },
        ]
      },
    }
    const fetchDocument = vi.fn(async () => okJson({ page: 2 }))
    const result = await collectAdapterDocuments({
      adapter,
      source,
      initialDocuments: initial,
      maxDocuments: 10,
      fetchDocument,
    })

    expect(result.status).toBe("complete")
    if (result.status === "complete") {
      expect(result.documents).toHaveLength(2)
    }
    expect(fetchDocument).toHaveBeenCalledTimes(1)
    const firstCall = fetchDocument.mock.calls[0] as unknown as [
      { url: string },
    ]
    expect(firstCall[0].url).toContain("page/2")
  })

  it("exports the shared poll and catalog caps", () => {
    expect(MAX_DOCUMENTS_PER_CYCLE).toBe(200)
    expect(MAX_CATALOG_DOCUMENTS_PER_SOURCE).toBe(200)
  })
})
