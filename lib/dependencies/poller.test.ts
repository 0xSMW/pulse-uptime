import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import anthropicOperational from "./adapters/fixtures/anthropic/operational.json"
import anthropicOutage from "./adapters/fixtures/anthropic/outage.json"
import postmarkComponentsOperational from "./adapters/fixtures/postmark/components-operational.json"
import postmarkNoticeDetail from "./adapters/fixtures/postmark/notice-detail-503440.json"
import postmarkNoticesListOne from "./adapters/fixtures/postmark/notices-list-one.json"
import { ProviderFetchError } from "./fetch"
import { loadCatalogManifest } from "./manifest"
import {
  DocumentBudgetExceededError,
  MAX_DOCUMENTS_PER_CYCLE,
  type PollerSourceRow,
  type PollOutcome,
  pollDueSources,
} from "./poller"

const manifest = loadCatalogManifest()
const anthropicManifestSource = manifest.sources.find(
  (source) => source.id === "anthropic"
)!
const postmarkManifestSource = manifest.sources.find(
  (source) => source.id === "postmark"
)!
// Neon uses statusio_public, whose requests() returns a single document, so it
// is the genuine single-document source that keeps the 304 fast-path. Anthropic
// is statuspage_v2, whose only required document is summary.json (incidents.json
// and scheduled-maintenances are optional), so its summary 304 also stands in
// for the whole source. Postmark is sorry_v1, whose required notice lists mean
// its primary never stands alone.
const neonManifestSource = manifest.sources.find(
  (source) => source.id === "neon"
)!

type ManifestSource = typeof anthropicManifestSource

function rowFromManifest(
  source: ManifestSource,
  overrides: Partial<PollerSourceRow> = {}
): PollerSourceRow {
  return {
    id: source.id,
    provider: source.provider,
    adapter: source.adapter,
    currentUrl: source.currentUrl,
    incidentsUrl: source.incidentsUrl,
    statusPageUrl: source.statusPageUrl,
    allowedHosts: source.allowedHosts,
    config: source.config,
    operationalPollSeconds: source.operationalPollSeconds,
    activePollSeconds: source.activePollSeconds,
    staleAfterSeconds: source.staleAfterSeconds,
    etag: null,
    lastModified: null,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    ...overrides,
  }
}

function sourceRow(overrides: Partial<PollerSourceRow> = {}): PollerSourceRow {
  return rowFromManifest(anthropicManifestSource, overrides)
}

const NOW = new Date("2026-07-19T15:00:00.000Z")
const maintenanceDocUrl = new URL(
  "/api/v2/scheduled-maintenances/active.json",
  anthropicManifestSource.currentUrl
).toString()
const emptyMaintenanceDoc = {
  page: { id: "tymt9n04zgry", updated_at: NOW.toISOString() },
  scheduled_maintenances: [],
}
const emptyIncidentsDoc = {
  page: { id: "tymt9n04zgry", updated_at: NOW.toISOString() },
  incidents: [],
}

function anthropicFetchDocument(bySourceDoc: unknown) {
  return async (_source: PollerSourceRow, request: { url: string }) => {
    if (request.url === maintenanceDocUrl) {
      return {
        status: "ok" as const,
        statusCode: 200,
        json: emptyMaintenanceDoc,
        etag: null,
        lastModified: null,
      }
    }
    if (request.url === anthropicManifestSource.incidentsUrl) {
      return {
        status: "ok" as const,
        statusCode: 200,
        json: emptyIncidentsDoc,
        etag: null,
        lastModified: null,
      }
    }
    if (request.url === anthropicManifestSource.currentUrl) {
      return {
        status: "ok" as const,
        statusCode: 200,
        json: bySourceDoc,
        etag: '"abc"',
        lastModified: null,
      }
    }
    throw new Error(`unexpected url ${request.url}`)
  }
}

describe("pollDueSources orchestration", () => {
  it("skips entirely when no source is due", async () => {
    const persist = vi.fn()
    const result = await pollDueSources({
      store: { listDueSources: vi.fn().mockResolvedValue([]) },
      persist,
      now: () => NOW,
    })
    expect(result).toEqual({
      sourcesDue: 0,
      polled: 0,
      notModified: 0,
      failed: 0,
    })
    expect(persist).not.toHaveBeenCalled()
  })

  it("fetches, normalizes, and hands a snapshot outcome to persist", async () => {
    const persist = vi.fn()
    const row = sourceRow()
    const result = await pollDueSources({
      store: { listDueSources: vi.fn().mockResolvedValue([row]) },
      fetchDocument: anthropicFetchDocument(anthropicOperational),
      persist,
      now: () => NOW,
    })
    expect(result).toEqual({
      sourcesDue: 1,
      polled: 1,
      notModified: 0,
      failed: 0,
    })
    expect(persist).toHaveBeenCalledTimes(1)
    const [outcome] = persist.mock.calls[0] as [PollOutcome]
    expect(outcome.kind).toBe("snapshot")
    if (outcome.kind === "snapshot") {
      expect(outcome.snapshot.components.k8w3r06qmzrp.state).toBe("OPERATIONAL")
      expect(outcome.etag).toBe('"abc"')
    }
  })

  it("stops at a single-document source's 304, replaying its validators, and never calls normalize", async () => {
    const persist = vi.fn()
    // Neon is statusio_public: one document, so its 304 stands in for the whole source.
    const row = rowFromManifest(neonManifestSource, { etag: '"cached"' })
    const fetchDocument = vi.fn(
      async (
        _source: PollerSourceRow,
        request: {
          url: string
          validators?: { etag: string | null; lastModified: string | null }
        }
      ) => {
        expect(request.url).toBe(neonManifestSource.currentUrl)
        // The single primary document is fetched conditionally with the stored validator.
        expect(request.validators).toEqual({
          etag: '"cached"',
          lastModified: null,
        })
        return {
          status: "not_modified" as const,
          etag: '"cached"',
          lastModified: null,
        }
      }
    )
    const result = await pollDueSources({
      store: { listDueSources: vi.fn().mockResolvedValue([row]) },
      fetchDocument,
      persist,
      now: () => NOW,
    })
    expect(result).toEqual({
      sourcesDue: 1,
      polled: 0,
      notModified: 1,
      failed: 0,
    })
    expect(fetchDocument).toHaveBeenCalledTimes(1)
    const [outcome] = persist.mock.calls[0] as [PollOutcome]
    expect(outcome.kind).toBe("not_modified")
  })

  it("isolates a failure to its own source and still persists the failure outcome", async () => {
    const persist = vi.fn()
    const failingRow = sourceRow({ id: "broken" })
    const healthyRow = sourceRow()
    const fetchDocument = vi.fn(
      async (source: PollerSourceRow, request: { url: string }) => {
        if (source.id === "broken") {
          throw new Error("network exploded")
        }
        return anthropicFetchDocument(anthropicOutage)(source, request)
      }
    )
    const result = await pollDueSources({
      store: {
        listDueSources: vi.fn().mockResolvedValue([failingRow, healthyRow]),
      },
      fetchDocument,
      persist,
      now: () => NOW,
      concurrency: 4,
    })
    expect(result).toEqual({
      sourcesDue: 2,
      polled: 1,
      notModified: 0,
      failed: 1,
    })
    const outcomes = persist.mock.calls.map((call) => call[0] as PollOutcome)
    expect(
      outcomes.find((outcome) => outcome.sourceId === "broken")?.kind
    ).toBe("failure")
    expect(
      outcomes.find(
        (outcome) => outcome.sourceId === anthropicManifestSource.id
      )?.kind
    ).toBe("snapshot")
  })

  it("skips an optional secondary document whose fetch throws and still yields a snapshot", async () => {
    const persist = vi.fn()
    const row = sourceRow()
    const fetchDocument = vi.fn(
      async (source: PollerSourceRow, request: { url: string }) => {
        // The optional scheduled-maintenances document is unreachable this cycle.
        // normalize() falls back to the summary's inline maintenances.
        if (request.url === maintenanceDocUrl) {
          throw new ProviderFetchError(
            "HTTP_STATUS",
            "anthropic: unexpected status 404",
            404
          )
        }
        return anthropicFetchDocument(anthropicOperational)(source, request)
      }
    )
    const result = await pollDueSources({
      store: { listDueSources: vi.fn().mockResolvedValue([row]) },
      fetchDocument,
      persist,
      now: () => NOW,
    })
    expect(result).toEqual({
      sourcesDue: 1,
      polled: 1,
      notModified: 0,
      failed: 0,
    })
    const [outcome] = persist.mock.calls[0] as [PollOutcome]
    expect(outcome.kind).toBe("snapshot")
    if (outcome.kind === "snapshot") {
      expect(outcome.snapshot.components.k8w3r06qmzrp.state).toBe("OPERATIONAL")
    }
    // The failed optional document is requested exactly once, not re-fetched in a loop.
    const maintenanceCalls = fetchDocument.mock.calls.filter(
      (call) => (call[1] as { url: string }).url === maintenanceDocUrl
    )
    expect(maintenanceCalls).toHaveLength(1)
  })

  it("fails the whole source when a required document's fetch throws, carrying its retry-after", async () => {
    const persist = vi.fn()
    const row = sourceRow()
    const fetchDocument = vi.fn(
      async (_source: PollerSourceRow, request: { url: string }) => {
        // The primary summary document is required, so its fetch error is fatal.
        if (request.url === anthropicManifestSource.currentUrl) {
          throw new ProviderFetchError(
            "HTTP_STATUS",
            "anthropic: unexpected status 503",
            503,
            30_000
          )
        }
        throw new Error(`unexpected url ${request.url}`)
      }
    )
    const result = await pollDueSources({
      store: { listDueSources: vi.fn().mockResolvedValue([row]) },
      fetchDocument,
      persist,
      now: () => NOW,
    })
    expect(result).toEqual({
      sourcesDue: 1,
      polled: 0,
      notModified: 0,
      failed: 1,
    })
    const [outcome] = persist.mock.calls[0] as [PollOutcome]
    expect(outcome.kind).toBe("failure")
    if (outcome.kind === "failure") {
      expect(outcome.retryAfterMs).toBe(30_000)
    }
  })

  it("drives the sorry_v1 two-pass protocol end to end: pagination-free components, notice list, then per-notice detail", async () => {
    const postmarkRow: PollerSourceRow = {
      id: postmarkManifestSource.id,
      provider: postmarkManifestSource.provider,
      adapter: postmarkManifestSource.adapter,
      currentUrl: postmarkManifestSource.currentUrl,
      incidentsUrl: postmarkManifestSource.incidentsUrl,
      statusPageUrl: postmarkManifestSource.statusPageUrl,
      allowedHosts: postmarkManifestSource.allowedHosts,
      config: postmarkManifestSource.config,
      operationalPollSeconds: postmarkManifestSource.operationalPollSeconds,
      activePollSeconds: postmarkManifestSource.activePollSeconds,
      staleAfterSeconds: postmarkManifestSource.staleAfterSeconds,
      etag: null,
      lastModified: null,
      consecutiveFailures: 0,
      lastSuccessAt: null,
    }
    const componentsUrl = postmarkManifestSource.config.componentsUrl as string
    const noticeDetailUrl = (
      postmarkManifestSource.config.noticeDetailUrlTemplate as string
    ).replace("{id}", "503440")
    const persist = vi.fn()
    const fetchDocument = vi.fn(
      async (_source: PollerSourceRow, request: { url: string }) => {
        if (request.url === componentsUrl) {
          return {
            status: "ok" as const,
            statusCode: 200,
            json: postmarkComponentsOperational,
            etag: null,
            lastModified: null,
          }
        }
        if (request.url === noticeDetailUrl) {
          return {
            status: "ok" as const,
            statusCode: 200,
            json: postmarkNoticeDetail,
            etag: null,
            lastModified: null,
          }
        }
        if (request.url.startsWith(postmarkManifestSource.incidentsUrl!)) {
          return {
            status: "ok" as const,
            statusCode: 200,
            json: postmarkNoticesListOne,
            etag: null,
            lastModified: null,
          }
        }
        throw new Error(`unexpected url ${request.url}`)
      }
    )

    const result = await pollDueSources({
      store: { listDueSources: vi.fn().mockResolvedValue([postmarkRow]) },
      fetchDocument,
      persist,
      now: () => NOW,
    })

    expect(result.polled).toBe(1)
    const [outcome] = persist.mock.calls[0] as [PollOutcome]
    expect(outcome.kind).toBe("snapshot")
    if (outcome.kind === "snapshot") {
      expect(outcome.snapshot.incidents).toHaveLength(1)
      expect(outcome.snapshot.incidents[0].externalId).toBe("503440")
    }
    // components + present notices list + past notices list + notice-detail:
    // four distinct documents fetched.
    const urlsFetched = new Set(
      fetchDocument.mock.calls.map((call) => (call[1] as { url: string }).url)
    )
    expect(urlsFetched.size).toBe(4)
  })

  it("does not let the components document's 304 abort a sorry_v1 cycle, so an ended notice is still observed", async () => {
    const cachedEtag = '"components-cached"'
    const componentsUrl = postmarkManifestSource.config.componentsUrl as string
    const noticeDetailUrl = (
      postmarkManifestSource.config.noticeDetailUrlTemplate as string
    ).replace("{id}", "503440")
    const postmarkRow: PollerSourceRow = {
      id: postmarkManifestSource.id,
      provider: postmarkManifestSource.provider,
      adapter: postmarkManifestSource.adapter,
      currentUrl: postmarkManifestSource.currentUrl,
      incidentsUrl: postmarkManifestSource.incidentsUrl,
      statusPageUrl: postmarkManifestSource.statusPageUrl,
      allowedHosts: postmarkManifestSource.allowedHosts,
      config: postmarkManifestSource.config,
      operationalPollSeconds: postmarkManifestSource.operationalPollSeconds,
      activePollSeconds: postmarkManifestSource.activePollSeconds,
      staleAfterSeconds: postmarkManifestSource.staleAfterSeconds,
      // A prior cycle cached the components validator.
      etag: cachedEtag,
      lastModified: null,
      consecutiveFailures: 0,
      lastSuccessAt: null,
    }
    const persist = vi.fn()
    const fetchDocument = vi.fn(
      async (
        _source: PollerSourceRow,
        request: {
          url: string
          validators?: { etag: string | null; lastModified: string | null }
        }
      ) => {
        if (request.url === componentsUrl) {
          // A real server would answer a conditional request with 304. The poller
          // must not send validators for the components document while required
          // notice lists remain, so this stays a full 200 and the notice feeds
          // are still fetched.
          if (request.validators) {
            return {
              status: "not_modified" as const,
              etag: cachedEtag,
              lastModified: null,
            }
          }
          return {
            status: "ok" as const,
            statusCode: 200,
            json: postmarkComponentsOperational,
            etag: cachedEtag,
            lastModified: null,
          }
        }
        if (request.url === noticeDetailUrl) {
          return {
            status: "ok" as const,
            statusCode: 200,
            json: postmarkNoticeDetail,
            etag: null,
            lastModified: null,
          }
        }
        if (request.url.startsWith(postmarkManifestSource.incidentsUrl!)) {
          return {
            status: "ok" as const,
            statusCode: 200,
            json: postmarkNoticesListOne,
            etag: null,
            lastModified: null,
          }
        }
        throw new Error(`unexpected url ${request.url}`)
      }
    )

    const result = await pollDueSources({
      store: { listDueSources: vi.fn().mockResolvedValue([postmarkRow]) },
      fetchDocument,
      persist,
      now: () => NOW,
    })

    expect(result).toEqual({
      sourcesDue: 1,
      polled: 1,
      notModified: 0,
      failed: 0,
    })
    const componentsCall = fetchDocument.mock.calls.find(
      (call) => (call[1] as { url: string }).url === componentsUrl
    )
    expect(
      (componentsCall![1] as { validators?: unknown }).validators
    ).toBeUndefined()
    const [outcome] = persist.mock.calls[0] as [PollOutcome]
    expect(outcome.kind).toBe("snapshot")
    if (outcome.kind === "snapshot") {
      expect(outcome.snapshot.incidents).toHaveLength(1)
      expect(outcome.snapshot.incidents[0].externalId).toBe("503440")
      // The ended notice's resolvedAt is observed, which a 304-aborted cycle would never see.
      expect(outcome.snapshot.incidents[0].resolvedAt).toBe(
        "2026-07-07T01:06:26.688Z"
      )
    }
    const urlsFetched = new Set(
      fetchDocument.mock.calls.map((call) => (call[1] as { url: string }).url)
    )
    expect(urlsFetched.has(noticeDetailUrl)).toBe(true)
  })

  it("persists the primary document's own etag and replays it on the primary alone next cycle", async () => {
    const currentEtag = '"current-etag"'
    const currentLastModified = "Mon, 01 Jan 2024 00:00:00 GMT"
    const incidentsEtag = '"incidents-etag"'
    const incidentsLastModified = "Wed, 03 Jan 2024 00:00:00 GMT"

    const persist = vi.fn()
    const row = sourceRow()
    const firstCycleFetch = vi.fn(
      async (_source: PollerSourceRow, request: { url: string }) => {
        if (request.url === maintenanceDocUrl) {
          return {
            status: "ok" as const,
            statusCode: 200,
            json: emptyMaintenanceDoc,
            etag: null,
            lastModified: null,
          }
        }
        if (request.url === anthropicManifestSource.incidentsUrl) {
          return {
            status: "ok" as const,
            statusCode: 200,
            json: emptyIncidentsDoc,
            etag: incidentsEtag,
            lastModified: incidentsLastModified,
          }
        }
        if (request.url === anthropicManifestSource.currentUrl) {
          return {
            status: "ok" as const,
            statusCode: 200,
            json: anthropicOperational,
            etag: currentEtag,
            lastModified: currentLastModified,
          }
        }
        throw new Error(`unexpected url ${request.url}`)
      }
    )

    const firstResult = await pollDueSources({
      store: { listDueSources: vi.fn().mockResolvedValue([row]) },
      fetchDocument: firstCycleFetch,
      persist,
      now: () => NOW,
    })
    expect(firstResult).toEqual({
      sourcesDue: 1,
      polled: 1,
      notModified: 0,
      failed: 0,
    })

    const [firstOutcome] = persist.mock.calls[0] as [PollOutcome]
    expect(firstOutcome.kind).toBe("snapshot")
    if (firstOutcome.kind !== "snapshot") {
      throw new Error("expected snapshot outcome")
    }
    // The incidents document resolves later than the current document, so a
    // validator capture that is not scoped to the primary document would
    // persist the incidents document's etag and last-modified instead.
    expect(firstOutcome.etag).toBe(currentEtag)
    expect(firstOutcome.lastModified).toBe(currentLastModified)

    const secondRow = sourceRow({
      etag: firstOutcome.etag,
      lastModified: firstOutcome.lastModified,
    })
    const secondCycleFetch = vi.fn(
      async (
        _source: PollerSourceRow,
        request: {
          url: string
          validators?: { etag: string | null; lastModified: string | null }
        }
      ) => {
        // The summary is the source's one required document, so it alone carries
        // the stored conditional validators. Its optional secondaries are fetched
        // without validators once the summary returns a full 200.
        if (request.url === anthropicManifestSource.currentUrl) {
          expect(request.validators).toEqual({
            etag: currentEtag,
            lastModified: currentLastModified,
          })
          return {
            status: "ok" as const,
            statusCode: 200,
            json: anthropicOperational,
            etag: currentEtag,
            lastModified: currentLastModified,
          }
        }
        expect(request.validators).toBeUndefined()
        if (request.url === anthropicManifestSource.incidentsUrl) {
          return {
            status: "ok" as const,
            statusCode: 200,
            json: emptyIncidentsDoc,
            etag: incidentsEtag,
            lastModified: incidentsLastModified,
          }
        }
        if (request.url === maintenanceDocUrl) {
          return {
            status: "ok" as const,
            statusCode: 200,
            json: emptyMaintenanceDoc,
            etag: null,
            lastModified: null,
          }
        }
        throw new Error(`unexpected url ${request.url}`)
      }
    )

    await pollDueSources({
      store: { listDueSources: vi.fn().mockResolvedValue([secondRow]) },
      fetchDocument: secondCycleFetch,
      persist,
      now: () => NOW,
    })

    expect(secondCycleFetch).toHaveBeenCalledTimes(3)
  })

  it("short-circuits a statuspage summary 304 to not_modified without fetching the optional secondaries", async () => {
    // The summary is the source's one required document and lists every active
    // incident inline, so an unchanged summary means nothing resolved. The
    // cycle stops on the 304 and the optional incidents.json and maintenance
    // are never fetched, which is the conditional-GET fast path this source
    // spends most cycles on.
    const persist = vi.fn()
    const row = sourceRow({ etag: '"summary-cached"' })
    const fetchDocument = vi.fn(
      async (
        _source: PollerSourceRow,
        request: {
          url: string
          validators?: { etag: string | null; lastModified: string | null }
        }
      ) => {
        expect(request.url).toBe(anthropicManifestSource.currentUrl)
        expect(request.validators).toEqual({
          etag: '"summary-cached"',
          lastModified: null,
        })
        return {
          status: "not_modified" as const,
          etag: '"summary-cached"',
          lastModified: null,
        }
      }
    )

    const result = await pollDueSources({
      store: { listDueSources: vi.fn().mockResolvedValue([row]) },
      fetchDocument,
      persist,
      now: () => NOW,
    })

    expect(result).toEqual({
      sourcesDue: 1,
      polled: 0,
      notModified: 1,
      failed: 0,
    })
    expect(fetchDocument).toHaveBeenCalledTimes(1)
    const [outcome] = persist.mock.calls[0] as [PollOutcome]
    expect(outcome.kind).toBe("not_modified")
  })

  it("observes a resolved incident on the 200 the summary returns when it changes, replaying validators the server answers full", async () => {
    // A resolution drops the incident from summary.json's inline set, so the
    // summary changes and the conditional request comes back 200, not 304. The
    // poller then fetches incidents.json and the resolution surfaces with its
    // real resolved_at.
    const resolvedIncidentsDoc = {
      page: { id: "tymt9n04zgry", updated_at: NOW.toISOString() },
      incidents: [
        {
          id: "inc-resolved-1",
          name: "Elevated API errors",
          status: "resolved",
          impact: "minor",
          created_at: "2026-07-18T10:00:00.000Z",
          updated_at: "2026-07-18T12:00:00.000Z",
          started_at: "2026-07-18T10:00:00.000Z",
          resolved_at: "2026-07-18T12:00:00.000Z",
          components: [],
          incident_updates: [],
        },
      ],
    }
    const persist = vi.fn()
    // The row carries a stale summary validator from the prior active cycle.
    const row = sourceRow({ etag: '"summary-active"' })
    const fetchDocument = vi.fn(
      async (
        _source: PollerSourceRow,
        request: {
          url: string
          validators?: { etag: string | null; lastModified: string | null }
        }
      ) => {
        if (request.url === maintenanceDocUrl) {
          return {
            status: "ok" as const,
            statusCode: 200,
            json: emptyMaintenanceDoc,
            etag: null,
            lastModified: null,
          }
        }
        if (request.url === anthropicManifestSource.incidentsUrl) {
          return {
            status: "ok" as const,
            statusCode: 200,
            json: resolvedIncidentsDoc,
            etag: null,
            lastModified: null,
          }
        }
        if (request.url === anthropicManifestSource.currentUrl) {
          // The stored validator is replayed, but the summary changed so the
          // server answers a full 200 with a fresh etag.
          expect(request.validators).toEqual({
            etag: '"summary-active"',
            lastModified: null,
          })
          return {
            status: "ok" as const,
            statusCode: 200,
            json: anthropicOperational,
            etag: '"summary-resolved"',
            lastModified: null,
          }
        }
        throw new Error(`unexpected url ${request.url}`)
      }
    )

    const result = await pollDueSources({
      store: { listDueSources: vi.fn().mockResolvedValue([row]) },
      fetchDocument,
      persist,
      now: () => NOW,
    })

    expect(result).toEqual({
      sourcesDue: 1,
      polled: 1,
      notModified: 0,
      failed: 0,
    })
    const urlsFetched = new Set(
      fetchDocument.mock.calls.map((call) => (call[1] as { url: string }).url)
    )
    expect(urlsFetched.has(anthropicManifestSource.incidentsUrl!)).toBe(true)
    const [outcome] = persist.mock.calls[0] as [PollOutcome]
    expect(outcome.kind).toBe("snapshot")
    if (outcome.kind === "snapshot") {
      expect(outcome.snapshot.incidents).toHaveLength(1)
      expect(outcome.snapshot.incidents[0].externalId).toBe("inc-resolved-1")
      expect(outcome.snapshot.incidents[0].resolvedAt).toBe(
        "2026-07-18T12:00:00.000Z"
      )
      // The primary summary's own new etag is persisted for the next cycle.
      expect(outcome.etag).toBe('"summary-resolved"')
    }
  })

  it("skips an optional incident document whose body stream times out and still yields a snapshot from the required summary", async () => {
    // A body-stream UND_ERR_BODY_TIMEOUT surfaces as ProviderFetchError TIMEOUT
    // with stage body. On an optional document the poller skips it and continues
    // with the required summary, matching production optional-document fallback.
    const persist = vi.fn()
    const row = sourceRow()
    const fetchDocument = vi.fn(
      async (source: PollerSourceRow, request: { url: string }) => {
        if (request.url === anthropicManifestSource.incidentsUrl) {
          throw new ProviderFetchError(
            "TIMEOUT",
            "anthropic: response body timed out",
            null,
            null,
            {
              sourceId: "anthropic",
              documentKind: "incidents",
              url: request.url,
              stage: "body",
            }
          )
        }
        return anthropicFetchDocument(anthropicOperational)(source, request)
      }
    )
    const result = await pollDueSources({
      store: { listDueSources: vi.fn().mockResolvedValue([row]) },
      fetchDocument,
      persist,
      now: () => NOW,
    })
    expect(result).toEqual({
      sourcesDue: 1,
      polled: 1,
      notModified: 0,
      failed: 0,
    })
    const [outcome] = persist.mock.calls[0] as [PollOutcome]
    expect(outcome.kind).toBe("snapshot")
    if (outcome.kind === "snapshot") {
      expect(outcome.snapshot.components.k8w3r06qmzrp.state).toBe("OPERATIONAL")
    }
  })

  it("fails the whole source with TIMEOUT when a required document's body stream times out", async () => {
    const persist = vi.fn()
    const row = sourceRow()
    const fetchDocument = vi.fn(
      async (_source: PollerSourceRow, request: { url: string }) => {
        if (request.url === anthropicManifestSource.currentUrl) {
          throw new ProviderFetchError(
            "TIMEOUT",
            "anthropic: response body timed out",
            null,
            null,
            {
              sourceId: "anthropic",
              documentKind: "current",
              url: request.url,
              stage: "body",
            }
          )
        }
        throw new Error(`unexpected url ${request.url}`)
      }
    )
    const result = await pollDueSources({
      store: { listDueSources: vi.fn().mockResolvedValue([row]) },
      fetchDocument,
      persist,
      now: () => NOW,
    })
    expect(result).toEqual({
      sourcesDue: 1,
      polled: 0,
      notModified: 0,
      failed: 1,
    })
    const [outcome] = persist.mock.calls[0] as [PollOutcome]
    expect(outcome.kind).toBe("failure")
    if (outcome.kind === "failure") {
      expect(outcome.error).toBeInstanceOf(ProviderFetchError)
      expect((outcome.error as ProviderFetchError).code).toBe("TIMEOUT")
      expect((outcome.error as ProviderFetchError).stage).toBe("body")
    }
  })

  it("fails the poll on a truncated RSS item so prior incident state is preserved", async () => {
    // A truncated trailing <item> is MALFORMED. The incident_feed adapter turns
    // that into AdapterParseError, and the poller records failure rather than
    // normalizing a partial item list that would look like a clean resolution.
    const openrouterSource = manifest.sources.find(
      (source) => source.id === "openrouter"
    )!
    const row = rowFromManifest(openrouterSource)
    const truncated = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Active outage</title>
    <guid>incident-active</guid>
    <description>IDENTIFIED - investigating</description>
  </item>
  <item>
    <title>Truncated later item
</channel></rss>`
    const persist = vi.fn()
    const fetchDocument = vi.fn(async () => ({
      status: "ok" as const,
      statusCode: 200,
      text: truncated,
      etag: null,
      lastModified: null,
    }))
    const result = await pollDueSources({
      store: { listDueSources: vi.fn().mockResolvedValue([row]) },
      fetchDocument,
      persist,
      now: () => NOW,
    })
    expect(result).toEqual({
      sourcesDue: 1,
      polled: 0,
      notModified: 0,
      failed: 1,
    })
    const [outcome] = persist.mock.calls[0] as [PollOutcome]
    expect(outcome.kind).toBe("failure")
    // Failure outcome means persist does not apply a snapshot, so prior incident
    // rows stay as they were for this source.
  })

  it("bounds a feed that paginates without end, failing the source with a recorded budget code", async () => {
    const componentsUrl = postmarkManifestSource.config.componentsUrl as string
    const postmarkRow = rowFromManifest(postmarkManifestSource)
    const persist = vi.fn()
    let componentsPage = 0
    const fetchDocument = vi.fn(
      async (_source: PollerSourceRow, request: { url: string }) => {
        // Every components page hands back a fresh, never-before-seen next_page,
        // so the two-pass loop would follow pagination forever without a bound.
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
        // The present and past notice lists resolve immediately with nothing to follow.
        if (request.url.startsWith(postmarkManifestSource.incidentsUrl!)) {
          return {
            status: "ok" as const,
            statusCode: 200,
            json: {
              notices: [],
              meta: { count: 0, total_count: 0, next_page: null },
            },
            etag: null,
            lastModified: null,
          }
        }
        throw new Error(`unexpected url ${request.url}`)
      }
    )

    const result = await pollDueSources({
      store: { listDueSources: vi.fn().mockResolvedValue([postmarkRow]) },
      fetchDocument,
      persist,
      now: () => NOW,
    })

    expect(result).toEqual({
      sourcesDue: 1,
      polled: 0,
      notModified: 0,
      failed: 1,
    })
    // The cap is enforced: exactly MAX_DOCUMENTS_PER_CYCLE fetches, then the next request throws before fetching.
    expect(fetchDocument).toHaveBeenCalledTimes(MAX_DOCUMENTS_PER_CYCLE)
    const [outcome] = persist.mock.calls[0] as [PollOutcome]
    expect(outcome.kind).toBe("failure")
    if (outcome.kind === "failure") {
      expect(outcome.error).toBeInstanceOf(DocumentBudgetExceededError)
      expect((outcome.error as DocumentBudgetExceededError).code).toBe(
        "DOCUMENT_BUDGET_EXCEEDED"
      )
      expect(outcome.retryAfterMs).toBeNull()
    }
  })
})
