import "server-only"

import { runBoundedWork } from "@/lib/async/bounded-work"
import { deadlineCanStart } from "@/lib/async/deadline"

import { AdapterParseError, resolveAdapter } from "./adapters"
import {
  collectAdapterDocuments,
  MAX_DOCUMENTS_PER_CYCLE,
} from "./document-collector"
import {
  createProviderDispatcher,
  type FetchDocumentResult,
  type FetchProviderDocumentDeps,
  ProviderFetchError,
} from "./fetch"
import type { DependencySourceManifest } from "./manifest"
import { fetchAdapterRequest } from "./source-fetch"
import type { DependencyAdapterName, NormalizedProviderSnapshot } from "./types"

// Selects due sources, fetches each exactly once per cycle, and drives the
// adapter registry's two-pass requests()/normalize() protocol. Never touches
// the database directly: persist.ts owns every write, so a source's poll
// outcome (snapshot, not-modified, or failure) is handed off whole.

export { MAX_DOCUMENTS_PER_CYCLE }

/**
 * Minimum remaining budget required to start another source. Matches one
 * provider request ceiling so a source is not claimed when it cannot open a
 * fetch before the work deadline.
 */
export const MIN_SOURCE_START_BUDGET_MS = 5000

export interface PollerSourceRow {
  id: string
  provider: string
  adapter: DependencyAdapterName
  currentUrl: string
  incidentsUrl: string | null
  statusPageUrl: string
  allowedHosts: string[]
  config: Record<string, unknown>
  operationalPollSeconds: number
  activePollSeconds: number
  staleAfterSeconds: number
  etag: string | null
  lastModified: string | null
  consecutiveFailures: number
  lastSuccessAt: Date | null
}

export interface PollerStore {
  /** Claims and returns enabled sources with at least one installed dependency and next_poll_at <= now. */
  claimDueSources: (now: Date) => Promise<PollerSourceRow[]>
}

export type PollOutcome =
  | {
      sourceId: string
      kind: "snapshot"
      snapshot: NormalizedProviderSnapshot
      etag: string | null
      lastModified: string | null
    }
  | {
      sourceId: string
      kind: "not_modified"
      etag: string | null
      lastModified: string | null
    }
  | {
      sourceId: string
      kind: "failure"
      error: Error
      retryAfterMs: number | null
    }

export interface PollDueSourcesDeps {
  store: PollerStore
  persist: (
    outcome: PollOutcome,
    source: PollerSourceRow,
    now: Date
  ) => Promise<void>
  fetchDocument?: (
    source: PollerSourceRow,
    request: {
      url: string
      validators?: { etag: string | null; lastModified: string | null }
      mode?: "json" | "text"
      documentKind?: string
      timeoutMs?: number
      deadlineAtMs?: number
    }
  ) => Promise<FetchDocumentResult>
  fetchDeps?: FetchProviderDocumentDeps
  now?: () => Date
  nowMs?: () => number
  concurrency?: number
  /** Absolute wall-clock deadline for the poll pool and every fetch. */
  deadlineAtMs?: number
}

export interface PollDueSourcesResult {
  sourcesDue: number
  polled: number
  notModified: number
  failed: number
  /** Due sources never started because the work budget was exhausted. */
  skipped: number
}

function toManifestSource(row: PollerSourceRow): DependencySourceManifest {
  return {
    id: row.id,
    provider: row.provider,
    adapter: row.adapter,
    currentUrl: row.currentUrl,
    incidentsUrl: row.incidentsUrl,
    statusPageUrl: row.statusPageUrl,
    allowedHosts: row.allowedHosts,
    operationalPollSeconds: row.operationalPollSeconds,
    activePollSeconds: row.activePollSeconds,
    staleAfterSeconds: row.staleAfterSeconds,
    config: row.config,
  }
}

/** Raised when a source's requests() keeps asking for documents past MAX_DOCUMENTS_PER_CYCLE. Carries a code so the failure outcome records the truncation. */
export class DocumentBudgetExceededError extends Error {
  readonly code = "DOCUMENT_BUDGET_EXCEEDED"
  constructor(sourceId: string, limit: number) {
    super(
      `${sourceId}: exceeded the ${limit}-document fetch budget for one poll cycle`
    )
    this.name = "DocumentBudgetExceededError"
  }
}

/** Raised when collection stops mid-source because the work deadline is spent. */
export class PollDeadlineExceededError extends Error {
  readonly code = "POLL_DEADLINE_EXCEEDED"
  constructor(sourceId: string) {
    super(`${sourceId}: poll deadline exceeded before documents completed`)
    this.name = "PollDeadlineExceededError"
  }
}

/**
 * Drives one source's fetch/normalize cycle through the shared document
 * collector. The primary "current" document is fetched with stored validators
 * when it is the source's one required document, so a 304 short-circuits the
 * whole cycle. Optional secondary fetch failures are skipped so normalize()
 * can apply its documented fallback. A document-cap or deadline incomplete
 * result becomes a typed error so a partial fetch never resolves an incident
 * from truncated data.
 */
async function pollOneSource(
  source: PollerSourceRow,
  fetchDocument: NonNullable<PollDueSourcesDeps["fetchDocument"]>,
  now: Date,
  deadlineAtMs: number | undefined,
  nowMs: () => number
): Promise<PollOutcome> {
  const adapter = resolveAdapter(source.adapter)
  const manifestSource = toManifestSource(source)

  try {
    // The primary "current" document stands in for the whole source on a 304
    // only when it is the source's one required document. A required secondary
    // holds independent state the primary cannot vouch for.
    const primaryStandsAlone =
      adapter
        .requests(manifestSource, undefined)
        .filter((request) => request.optional !== true).length <= 1

    const collected = await collectAdapterDocuments({
      adapter,
      source: manifestSource,
      maxDocuments: MAX_DOCUMENTS_PER_CYCLE,
      skipOptionalFetchErrors: true,
      primaryStandsAlone,
      primaryValidators: primaryStandsAlone
        ? { etag: source.etag, lastModified: source.lastModified }
        : undefined,
      deadlineAtMs,
      nowMs,
      fetchDocument: (request, options) =>
        fetchDocument(source, {
          url: request.url,
          validators: options.validators,
          mode: request.mode,
          documentKind: request.kind,
          deadlineAtMs: options.deadlineAtMs,
        }),
    })

    if (collected.status === "not_modified") {
      return {
        sourceId: source.id,
        kind: "not_modified",
        etag: collected.etag,
        lastModified: collected.lastModified,
      }
    }

    if (collected.status === "incomplete") {
      // Cap or deadline never normalizes a partial snapshot.
      if (collected.reason === "deadline") {
        throw new PollDeadlineExceededError(source.id)
      }
      throw new DocumentBudgetExceededError(source.id, MAX_DOCUMENTS_PER_CYCLE)
    }

    const snapshot = adapter.normalize({
      source: manifestSource,
      documents: collected.documents,
      observedAt: now.toISOString(),
    })
    return {
      sourceId: source.id,
      kind: "snapshot",
      snapshot,
      etag: collected.cacheEtag ?? source.etag,
      lastModified: collected.cacheLastModified ?? source.lastModified,
    }
  } catch (error) {
    const retryAfterMs =
      error instanceof ProviderFetchError ? error.retryAfterMs : null
    const normalized =
      error instanceof ProviderFetchError ||
      error instanceof AdapterParseError ||
      error instanceof DocumentBudgetExceededError ||
      error instanceof PollDeadlineExceededError
        ? error
        : error instanceof Error
          ? error
          : new Error(String(error))
    return {
      sourceId: source.id,
      kind: "failure",
      error: normalized,
      retryAfterMs,
    }
  }
}

export async function pollDueSources(
  deps: PollDueSourcesDeps
): Promise<PollDueSourcesResult> {
  const now = deps.now ?? (() => new Date())
  const nowMs = deps.nowMs ?? Date.now
  const nowDate = now()
  const sources = await deps.store.claimDueSources(nowDate)
  const deadlineAtMs = deps.deadlineAtMs
  const concurrency = deps.concurrency ?? 4

  // One dispatcher serves the whole cycle so a source's documents on the same
  // host reuse a single keep-alive connection instead of paying TLS and DNS
  // setup per document. It carries the same connect-time secure lookup, and
  // fetchProviderDocument still re-checks the host allowlist, redirect cap,
  // deadline, and body cap on every document and hop. The default fetch path
  // owns it and closes it in the finally. An injected fetchDocument owns
  // fetching entirely, so none is created.
  const dispatcher =
    deps.fetchDocument || sources.length === 0
      ? null
      : createProviderDispatcher(deps.fetchDeps)
  // Default path goes through source-fetch so body caps, mode, and documentKind
  // match catalog revalidation. Injected fetchDocument owns fetching entirely.
  const fetchDocument =
    deps.fetchDocument ??
    ((source, request) =>
      fetchAdapterRequest(
        source,
        {
          kind:
            request.documentKind === "incidents" ||
            request.documentKind === "maintenance"
              ? request.documentKind
              : "current",
          url: request.url,
          mode: request.mode,
        },
        {
          ...deps.fetchDeps,
          dispatcher: dispatcher ?? undefined,
          validators: request.validators,
          timeoutMs: request.timeoutMs,
          deadlineAtMs: request.deadlineAtMs,
        }
      ))

  let polled = 0
  let notModified = 0
  let failed = 0
  let stopStartingForInfra = false

  try {
    const outcomes = await runBoundedWork(sources, {
      concurrency,
      shouldStop: () => {
        if (stopStartingForInfra) {
          return true
        }
        if (typeof deadlineAtMs !== "number") {
          return false
        }
        return !deadlineCanStart(
          deadlineAtMs,
          MIN_SOURCE_START_BUDGET_MS,
          nowMs()
        )
      },
      worker: async (source) => {
        const outcome = await pollOneSource(
          source,
          fetchDocument,
          nowDate,
          deadlineAtMs,
          nowMs
        )
        if (outcome.kind === "snapshot") {
          polled += 1
        } else if (outcome.kind === "not_modified") {
          notModified += 1
        } else {
          failed += 1
        }
        try {
          await deps.persist(outcome, source, nowDate)
        } catch (error) {
          // Persistence is infrastructure. Stop claiming new sources, let
          // started workers settle, then surface after the pool returns.
          stopStartingForInfra = true
          throw error
        }
        return outcome
      },
    })

    let skipped = 0
    const infraErrors: Error[] = []
    for (const outcome of outcomes) {
      if (outcome.status === "skipped") {
        skipped += 1
      } else if (outcome.status === "rejected") {
        infraErrors.push(
          outcome.reason instanceof Error
            ? outcome.reason
            : new Error(String(outcome.reason))
        )
      }
    }

    const pollCounts = {
      sourcesDue: sources.length,
      polled,
      notModified,
      failed,
      skipped,
    }

    if (infraErrors.length > 0) {
      const error = new AggregateError(
        infraErrors,
        "Dependency source persistence failed"
      ) as AggregateError & { pollCounts: typeof pollCounts }
      // Truthful partial counters for cron_runs even when persistence fails.
      error.pollCounts = pollCounts
      throw error
    }

    return pollCounts
  } finally {
    // Close only after every started worker has settled so in-flight fetches
    // still use the shared dispatcher.
    if (dispatcher) {
      await dispatcher.close()
    }
  }
}
