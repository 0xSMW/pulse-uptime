// Shared adapter document collection for the poller and catalog revalidation.
// Owns the two-pass requests() loop, per-source document caps, and wall-clock
// deadlines. Callers inject fetchDocument so body policy and dispatchers stay
// outside this module. Cap or deadline mid-collection yields a typed incomplete
// result: callers must not normalize partial documents as a full snapshot.

import type {
  AdapterDocument,
  AdapterDocumentKind,
  AdapterRequestDescriptor,
  DependencyAdapter,
} from "./adapters";
import { ProviderFetchError, type FetchDocumentResult, type FetchValidators } from "./fetch";
import type { DependencySourceManifest } from "./manifest";

/**
 * Upper bound on documents fetched for a single source in one poll cycle.
 * The largest legitimate cycle is small: statuspage_v2 fetches 3 (summary,
 * incidents, maintenance), incidentio_compat 2, google_cloud_status and
 * statusio_public 1, and sorry_v1 stays in the low tens. 200 leaves headroom
 * while still capping a buggy or hostile feed that emits unique next_page or
 * notice-detail URLs without end.
 */
export const MAX_DOCUMENTS_PER_CYCLE = 200;

/**
 * Catalog validation hard cap per source. Same magnitude as the poll cycle
 * cap for now. Deadline remains the dominant bound during maintenance.
 */
export const MAX_CATALOG_DOCUMENTS_PER_SOURCE = 200;

export type DocumentCollectorAdapter = Pick<DependencyAdapter, "requests">;

export type CollectDocumentsFetch = (
  request: AdapterRequestDescriptor,
  options: {
    deadlineAtMs?: number;
    validators?: FetchValidators;
  },
) => Promise<FetchDocumentResult>;

export type CollectDocumentsInput = {
  adapter: DocumentCollectorAdapter;
  source: DependencySourceManifest;
  /** Documents already in hand (resume a multi-pass adapter). */
  initialDocuments?: AdapterDocument[];
  /** When set, only descriptors whose kind is in this set are fetched. */
  allowedKinds?: ReadonlySet<AdapterDocumentKind> | readonly AdapterDocumentKind[];
  maxDocuments: number;
  deadlineAtMs?: number;
  /**
   * When true, ProviderFetchError on optional descriptors is skipped so the
   * cycle can finish on required documents. Poller policy; catalog leaves false.
   */
  skipOptionalFetchErrors?: boolean;
  fetchDocument: CollectDocumentsFetch;
  nowMs?: () => number;
  /**
   * Validators for the first primary "current" document when primaryStandsAlone
   * is true. A 304 on that request short-circuits the whole collection.
   */
  primaryValidators?: FetchValidators;
  /**
   * When true and the first request is the sole required document, a 304 on it
   * returns status "not_modified" without fetching secondaries.
   */
  primaryStandsAlone?: boolean;
};

export type CollectDocumentsResult =
  | {
      status: "complete";
      documents: AdapterDocument[];
      cacheEtag: string | null;
      cacheLastModified: string | null;
    }
  | {
      status: "not_modified";
      etag: string | null;
      lastModified: string | null;
    }
  | {
      status: "incomplete";
      reason: "document_cap" | "deadline";
      fetchedCount: number;
      /** Partial documents for diagnostics only. Never normalize these. */
      documents: AdapterDocument[];
    };

function kindAllowed(
  kind: AdapterDocumentKind,
  allowed: CollectDocumentsInput["allowedKinds"],
): boolean {
  if (!allowed) return true;
  if (allowed instanceof Set) return allowed.has(kind);
  return (allowed as readonly AdapterDocumentKind[]).includes(kind);
}

/**
 * Drives adapter.requests() until nothing new is pending or a hard bound hits.
 * Before every network request, checks document count and remaining wall time.
 * Remaining deadline is forwarded into fetchDocument so each hop clamps its
 * timeout to the caller's budget.
 */
export async function collectAdapterDocuments(
  input: CollectDocumentsInput,
): Promise<CollectDocumentsResult> {
  const nowMs = input.nowMs ?? Date.now;
  const documents: AdapterDocument[] = [...(input.initialDocuments ?? [])];
  const skippedOptionalUrls = new Set<string>();
  let fetchedDocumentCount = 0;
  let cacheEtag: string | null = null;
  let cacheLastModified: string | null = null;
  // Primary 304 path only applies when collection starts empty and the adapter
  // has at most one required document. initialDocuments means a resume, so the
  // 304 short-circuit does not apply.
  const mayShortCircuitPrimary =
    input.primaryStandsAlone === true
    && documents.length === 0
    && input.primaryValidators !== undefined;

  while (true) {
    const requests = input.adapter
      .requests(input.source, documents.length > 0 ? documents : undefined)
      .filter((request) => kindAllowed(request.kind, input.allowedKinds));
    const pending = requests.filter(
      (request) =>
        !documents.some((document) => document.url === request.url)
        && !skippedOptionalUrls.has(request.url),
    );
    if (pending.length === 0) break;

    for (const request of pending) {
      // Bound checks run before the fetch so an endless unique-URL chain never
      // issues the (maxDocuments + 1)th request.
      if (fetchedDocumentCount >= input.maxDocuments) {
        return {
          status: "incomplete",
          reason: "document_cap",
          fetchedCount: fetchedDocumentCount,
          documents,
        };
      }

      if (typeof input.deadlineAtMs === "number" && Number.isFinite(input.deadlineAtMs)) {
        if (nowMs() >= input.deadlineAtMs) {
          return {
            status: "incomplete",
            reason: "deadline",
            fetchedCount: fetchedDocumentCount,
            documents,
          };
        }
      }

      fetchedDocumentCount += 1;

      const isPrimaryDocument = mayShortCircuitPrimary && documents.length === 0;
      const validators = isPrimaryDocument ? input.primaryValidators : undefined;

      let result: FetchDocumentResult;
      try {
        result = await input.fetchDocument(request, {
          deadlineAtMs: input.deadlineAtMs,
          validators,
        });
      } catch (error) {
        if (
          input.skipOptionalFetchErrors === true
          && request.optional === true
          && error instanceof ProviderFetchError
        ) {
          skippedOptionalUrls.add(request.url);
          continue;
        }
        throw error;
      }

      if (result.status === "not_modified") {
        if (request.kind === "current" && isPrimaryDocument) {
          return {
            status: "not_modified",
            etag: result.etag,
            lastModified: result.lastModified,
          };
        }
        // Non-primary requests carry no conditional validators, so a 304 here
        // is a misbehaving server. Marking the url handled keeps the two-pass
        // loop from re-issuing it until the document cap fails the poll.
        skippedOptionalUrls.add(request.url);
        continue;
      }

      documents.push({
        kind: request.kind,
        url: request.url,
        json: result.json,
        text: result.text,
      });
      // Only the first successful document's validators are cacheable for the
      // next cycle's conditional primary request.
      if (documents.length === 1) {
        cacheEtag = result.etag ?? cacheEtag;
        cacheLastModified = result.lastModified ?? cacheLastModified;
      }
    }
  }

  return {
    status: "complete",
    documents,
    cacheEtag,
    cacheLastModified,
  };
}
