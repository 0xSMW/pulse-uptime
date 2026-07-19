import "server-only";

import { AdapterParseError, adapterRegistry, type AdapterDocument } from "./adapters";
import { ProviderFetchError, type FetchDocumentResult, type FetchProviderDocumentDeps } from "./fetch";
import { fetchProviderDocument } from "./fetch";
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
 * "current" document short-circuits the whole cycle before normalize() runs.
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

    while (true) {
      const requests = adapter.requests(manifestSource, documents.length > 0 ? documents : undefined);
      const pending = requests.filter((request) => !documents.some((document) => document.url === request.url));
      if (pending.length === 0) break;

      for (const request of pending) {
        const isFirstDocumentOfCycle = documents.length === 0;
        const validators = isFirstDocumentOfCycle ? { etag: source.etag, lastModified: source.lastModified } : undefined;
        const result = await fetchDocument(source, { url: request.url, validators });

        if (result.status === "not_modified") {
          if (request.kind === "current" && isFirstDocumentOfCycle) {
            return { sourceId: source.id, kind: "not_modified", etag: result.etag, lastModified: result.lastModified };
          }
          continue;
        }

        documents.push({ kind: request.kind, url: request.url, json: result.json, text: result.text });
        cacheEtag = result.etag ?? cacheEtag;
        cacheLastModified = result.lastModified ?? cacheLastModified;
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
  const fetchDocument = deps.fetchDocument
    ?? ((source, request) => fetchProviderDocument({ id: source.id, allowedHosts: source.allowedHosts }, request, deps.fetchDeps));

  const sources = await deps.store.listDueSources(nowDate);
  let polled = 0;
  let notModified = 0;
  let failed = 0;

  await runBounded(sources, deps.concurrency ?? 4, async (source) => {
    const outcome = await pollOneSource(source, fetchDocument, nowDate);
    if (outcome.kind === "snapshot") polled += 1;
    else if (outcome.kind === "not_modified") notModified += 1;
    else failed += 1;
    await deps.persist(outcome, source, nowDate);
  });

  return { sourcesDue: sources.length, polled, notModified, failed };
}
