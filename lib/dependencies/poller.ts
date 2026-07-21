import "server-only";

import { AdapterParseError, resolveAdapter } from "./adapters";
import { ProviderFetchError, type FetchDocumentResult, type FetchProviderDocumentDeps } from "./fetch";
import { createProviderDispatcher } from "./fetch";
import {
  collectAdapterDocuments,
  MAX_DOCUMENTS_PER_CYCLE,
} from "./document-collector";
import type { DependencySourceManifest } from "./manifest";
import { fetchAdapterRequest } from "./source-fetch";
import type { DependencyAdapterName, NormalizedProviderSnapshot } from "./types";

// Selects due sources, fetches each exactly once per cycle, and drives the
// adapter registry's two-pass requests()/normalize() protocol. Never touches
// the database directly: persist.ts owns every write, so a source's poll
// outcome (snapshot, not-modified, or failure) is handed off whole.

export { MAX_DOCUMENTS_PER_CYCLE };

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
  fetchDocument?: (source: PollerSourceRow, request: {
    url: string;
    validators?: { etag: string | null; lastModified: string | null };
    mode?: "json" | "text";
    documentKind?: string;
    timeoutMs?: number;
    deadlineAtMs?: number;
  }) => Promise<FetchDocumentResult>;
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
 * Drives one source's fetch/normalize cycle through the shared document
 * collector. The primary "current" document is fetched with stored validators
 * when it is the source's one required document, so a 304 short-circuits the
 * whole cycle. Optional secondary fetch failures are skipped so normalize()
 * can apply its documented fallback. A document-cap incomplete result becomes
 * DocumentBudgetExceededError so a partial fetch never resolves an incident
 * from truncated data.
 */
async function pollOneSource(
  source: PollerSourceRow,
  fetchDocument: NonNullable<PollDueSourcesDeps["fetchDocument"]>,
  now: Date,
): Promise<PollOutcome> {
  const adapter = resolveAdapter(source.adapter);
  const manifestSource = toManifestSource(source);

  try {
    // The primary "current" document stands in for the whole source on a 304
    // only when it is the source's one required document. A required secondary
    // holds independent state the primary cannot vouch for.
    const primaryStandsAlone = adapter.requests(manifestSource, undefined)
      .filter((request) => request.optional !== true).length <= 1;

    const collected = await collectAdapterDocuments({
      adapter,
      source: manifestSource,
      maxDocuments: MAX_DOCUMENTS_PER_CYCLE,
      skipOptionalFetchErrors: true,
      primaryStandsAlone,
      primaryValidators: primaryStandsAlone
        ? { etag: source.etag, lastModified: source.lastModified }
        : undefined,
      fetchDocument: (request, options) => fetchDocument(source, {
        url: request.url,
        validators: options.validators,
        mode: request.mode,
        documentKind: request.kind,
        deadlineAtMs: options.deadlineAtMs,
      }),
    });

    if (collected.status === "not_modified") {
      return {
        sourceId: source.id,
        kind: "not_modified",
        etag: collected.etag,
        lastModified: collected.lastModified,
      };
    }

    if (collected.status === "incomplete") {
      // Cap (or deadline, unused in normal polling) never normalizes a partial
      // snapshot. Fail the source with the recorded budget code.
      throw new DocumentBudgetExceededError(source.id, MAX_DOCUMENTS_PER_CYCLE);
    }

    const snapshot = adapter.normalize({
      source: manifestSource,
      documents: collected.documents,
      observedAt: now.toISOString(),
    });
    return {
      sourceId: source.id,
      kind: "snapshot",
      snapshot,
      etag: collected.cacheEtag ?? source.etag,
      lastModified: collected.cacheLastModified ?? source.lastModified,
    };
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
  // Default path goes through source-fetch so body caps, mode, and documentKind
  // match catalog revalidation. Injected fetchDocument owns fetching entirely.
  const fetchDocument = deps.fetchDocument
    ?? ((source, request) => fetchAdapterRequest(
      source,
      {
        kind: request.documentKind === "incidents" || request.documentKind === "maintenance"
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
      },
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
