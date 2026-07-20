import "server-only";

import { AdapterParseError, adapterRegistry, type AdapterDocument } from "./adapters";
import { ProviderFetchError, type FetchDocumentResult, type FetchProviderDocumentDeps } from "./fetch";
import { createProviderDispatcher, fetchProviderDocument } from "./fetch";
import type { DependencySourceManifest } from "./manifest";
import type { DependencyAdapterName, NormalizedProviderSnapshot } from "./types";

// Selects due sources, fetches each exactly once per cycle, and drives the
// adapter registry's two-pass requests()/normalize() protocol. Never touches
// the database directly: persist.ts owns every write, so a source's poll
// outcome (snapshot, not-modified, or failure) is handed off whole.

export interface PollerSourceRow {
  id: string;
  provider: string;
  adapter: DependencyAdapterName;
  currentUrl: string;
  incidentsUrl: string | null;
  statusPageUrl: string;
  allowedHosts: string[];
  config: Record<string, unknown>;
  operationalPollSeconds: number;
  activePollSeconds: number;
  staleAfterSeconds: number;
  etag: string | null;
  lastModified: string | null;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
}

export interface PollerStore {
  /** Enabled sources with at least one installed dependency and next_poll_at <= now. */
  listDueSources(now: Date): Promise<PollerSourceRow[]>;
}

export type PollOutcome =
  | { sourceId: string; kind: "snapshot"; snapshot: NormalizedProviderSnapshot; etag: string | null; lastModified: string | null }
  | { sourceId: string; kind: "not_modified"; etag: string | null; lastModified: string | null }
  | { sourceId: string; kind: "failure"; error: Error; retryAfterMs: number | null };

export interface PollDueSourcesDeps {
  store: PollerStore;
  persist(outcome: PollOutcome, source: PollerSourceRow, now: Date): Promise<void>;
  fetchDocument?: (source: PollerSourceRow, request: { url: string; validators?: { etag: string | null; lastModified: string | null } }) => Promise<FetchDocumentResult>;
  fetchDeps?: FetchProviderDocumentDeps;
  now?: () => Date;
  concurrency?: number;
}

export interface PollDueSourcesResult {
  sourcesDue: number;
  polled: number;
  notModified: number;
  failed: number;
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
  };
}

/**
 * Upper bound on documents fetched for a single source in one poll cycle.
 * The largest legitimate cycle is small: statuspage_v2 fetches 3 (summary,
 * incidents, maintenance), incidentio_compat 2, google_cloud_status and
 * statusio_public 1, and sorry_v1 fetches its components pages, its present
 * and past notice lists, and one detail per unplanned notice, which for a
 * real feed stays in the low tens. 200 leaves several times that headroom
 * while still capping a buggy or hostile feed that emits unique next_page or
 * notice-detail URLs without end, or answers 304 to an unconditional request
 * forever. Hitting the cap fails the source rather than normalizing a
 * truncated snapshot, so a partial fetch never resolves an incident or flips
 * a component from incomplete data.
 */
export const MAX_DOCUMENTS_PER_CYCLE = 200;

/** Raised when a source's requests() keeps asking for documents past MAX_DOCUMENTS_PER_CYCLE. Carries a code so the failure outcome records the truncation. */
export class DocumentBudgetExceededError extends Error {
  readonly code = "DOCUMENT_BUDGET_EXCEEDED";
  constructor(sourceId: string, limit: number) {
    super(`${sourceId}: exceeded the ${limit}-document fetch budget for one poll cycle`);
    this.name = "DocumentBudgetExceededError";
  }
}

async function runBounded<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      if (item) await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Drives one source's fetch/normalize cycle. Calls the adapter's requests()
 * repeatedly, each time handing back every document fetched so far, until it
 * returns nothing new: this is what lets sorry_v1 paginate components and
 * notices, and fetch one detail document per present notice, without the
 * poller knowing anything about Postmark's API shape. A 304 on the primary
 * "current" document short-circuits the whole cycle only when that document
 * is the source's one and only document. When the source has any other
 * document, required or optional, the primary is fetched without validators
 * to force a full 200 and every other document is fetched too. A secondary
 * document holds independent state, so an unchanged primary says nothing
 * about a statuspage incident that resolved in incidents.json or a sorry_v1
 * notice that ended, and normalize() runs on real content, applying its
 * documented fallback for any secondary that is genuinely absent. A per-cycle
 * document budget bounds pagination so a feed that emits fresh follow-up URLs
 * without end cannot starve the other due sources.
 */
async function pollOneSource(
  source: PollerSourceRow,
  fetchDocument: NonNullable<PollDueSourcesDeps["fetchDocument"]>,
  now: Date,
): Promise<PollOutcome> {
  const adapter = adapterRegistry[source.adapter];
  const manifestSource = toManifestSource(source);

  try {
    const documents: AdapterDocument[] = [];
    let cacheEtag = source.etag;
    let cacheLastModified = source.lastModified;
    let fetchedDocumentCount = 0;

    // The primary "current" document may stand in for the whole source on a 304
    // only when it is the source's one and only document. Any other document,
    // required or optional, holds independent state the primary cannot vouch
    // for: statuspage_v2's incidents.json carries the resolution of an incident
    // that summary.json no longer lists inline, and sorry_v1's notice lists
    // carry a notice that ended. So when the source has more than one document
    // the primary is fetched without validators to force a full 200, the
    // secondaries are fetched unconditionally too, and normalize() runs on real
    // content with its documented fallback for any secondary that is absent.
    const primaryStandsAlone = adapter.requests(manifestSource, undefined).length <= 1;

    // Optional secondary documents whose fetch failed this cycle. They are held
    // out of subsequent request rounds so the cycle can complete, and normalize()
    // applies its documented fallback for each absent document.
    const skippedOptionalUrls = new Set<string>();

    while (true) {
      const requests = adapter.requests(manifestSource, documents.length > 0 ? documents : undefined);
      const pending = requests.filter(
        (request) => !documents.some((document) => document.url === request.url) && !skippedOptionalUrls.has(request.url),
      );
      if (pending.length === 0) break;

      for (const request of pending) {
        // Fail before the fetch once the budget is spent, so a feed that
        // paginates forever is truncated into a recorded failure instead of
        // running until maxDuration and starving the other due sources.
        if (fetchedDocumentCount >= MAX_DOCUMENTS_PER_CYCLE) {
          throw new DocumentBudgetExceededError(source.id, MAX_DOCUMENTS_PER_CYCLE);
        }
        fetchedDocumentCount += 1;

        const isPrimaryDocument = documents.length === 0 && primaryStandsAlone;
        const validators = isPrimaryDocument ? { etag: source.etag, lastModified: source.lastModified } : undefined;

        let result: FetchDocumentResult;
        try {
          result = await fetchDocument(source, { url: request.url, validators });
        } catch (error) {
          // A fetch failure on an optional document never fails the source. It is
          // skipped and the cycle continues on the primary summary that already
          // succeeded. A required document's fetch error still propagates to the
          // outer catch, carrying its retry-after for failure backoff.
          if (request.optional === true && error instanceof ProviderFetchError) {
            skippedOptionalUrls.add(request.url);
            continue;
          }
          throw error;
        }

        if (result.status === "not_modified") {
          if (request.kind === "current" && isPrimaryDocument) {
            return { sourceId: source.id, kind: "not_modified", etag: result.etag, lastModified: result.lastModified };
          }
          continue;
        }

        documents.push({ kind: request.kind, url: request.url, json: result.json, text: result.text });
        // Validators are replayed only against the first document of the next
        // cycle, so only its own etag/lastModified may be persisted here.
        // Capturing a later document's validators would let a stale-by-then
        // 304 on the first document short-circuit the whole cycle.
        if (documents.length === 1) {
          cacheEtag = result.etag ?? cacheEtag;
          cacheLastModified = result.lastModified ?? cacheLastModified;
        }
      }
    }

    const snapshot = adapter.normalize({ source: manifestSource, documents, observedAt: now.toISOString() });
    return { sourceId: source.id, kind: "snapshot", snapshot, etag: cacheEtag, lastModified: cacheLastModified };
  } catch (error) {
    const retryAfterMs = error instanceof ProviderFetchError ? error.retryAfterMs : null;
    const normalized = error instanceof ProviderFetchError || error instanceof AdapterParseError
      ? error
      : error instanceof Error ? error : new Error(String(error));
    return { sourceId: source.id, kind: "failure", error: normalized, retryAfterMs };
  }
}

export async function pollDueSources(deps: PollDueSourcesDeps): Promise<PollDueSourcesResult> {
  const now = deps.now ?? (() => new Date());
  const nowDate = now();
  const sources = await deps.store.listDueSources(nowDate);

  // One dispatcher serves the whole cycle so a source's documents on the same
  // host reuse a single keep-alive connection instead of paying TLS and DNS
  // setup per document. It carries the same connect-time secure lookup, and
  // fetchProviderDocument still re-checks the host allowlist, redirect cap,
  // deadline, and body cap on every document and hop. The default fetch path
  // owns it and closes it in the finally. An injected fetchDocument owns
  // fetching entirely, so none is created.
  const dispatcher = deps.fetchDocument || sources.length === 0 ? null : createProviderDispatcher(deps.fetchDeps);
  const fetchDocument = deps.fetchDocument
    ?? ((source, request) => fetchProviderDocument(
      { id: source.id, allowedHosts: source.allowedHosts },
      request,
      { ...deps.fetchDeps, dispatcher: dispatcher ?? undefined },
    ));

  let polled = 0;
  let notModified = 0;
  let failed = 0;

  try {
    await runBounded(sources, deps.concurrency ?? 4, async (source) => {
      const outcome = await pollOneSource(source, fetchDocument, nowDate);
      if (outcome.kind === "snapshot") polled += 1;
      else if (outcome.kind === "not_modified") notModified += 1;
      else failed += 1;
      await deps.persist(outcome, source, nowDate);
    });

    return { sourcesDue: sources.length, polled, notModified, failed };
  } finally {
    if (dispatcher) await dispatcher.close();
  }
}
