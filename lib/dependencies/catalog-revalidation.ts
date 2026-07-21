import { resolveAdapter } from "./adapters"
import { googleProductsCatalogDirectory } from "./adapters/google-cloud-status"
import type { FetchCatalogDirectory } from "./catalog-sync"
import {
  collectAdapterDocuments,
  MAX_CATALOG_DOCUMENTS_PER_SOURCE,
} from "./document-collector"
import { createProviderDispatcher } from "./fetch"
import { loadCatalogManifest } from "./manifest"
import { fetchAdapterRequest } from "./source-fetch"
import type { CatalogComponentDirectory } from "./types"

// The live fetcher reconcileCatalog needs to confirm a source's feed still
// exposes every id its enabled presets select. Google Cloud is the one
// adapter that can't answer this from its own normalize() output: its
// components map only ever holds products with an active incident right
// now (see adapters/google-cloud-status.ts), so a quiet product would look
// like drift. Its manifest config carries a separate productsUrl for
// exactly this case. Every other adapter answers from its own "current"
// documents, fetched read-only and never persisted.
//
// All live fetches go through the shared document collector and source-fetch
// so body caps, request mode, host allowlists, document caps, and deadline
// budgets match the poller. Incomplete collection never yields a directory.

interface LiveCatalogDirectoryArgs {
  source: {
    id: string
    adapter: string
    currentUrl: string
  }
  deadlineAtMs?: number
  nowMs?: () => number
}

async function fetchGoogleProductsDirectory(
  source: ReturnType<typeof loadCatalogManifest>["sources"][number],
  productsUrl: string,
  args: Pick<LiveCatalogDirectoryArgs, "deadlineAtMs">
): Promise<CatalogComponentDirectory | null> {
  // Same source descriptor and JSON mode as any other dependency document so
  // the products roster inherits the source host allowlist and body policy.
  // Deadline is forwarded so a slow products.json cannot overrun the slice.
  const result = await fetchAdapterRequest(
    source,
    { kind: "current", url: productsUrl, mode: "json" },
    { deadlineAtMs: args.deadlineAtMs }
  )
  if (result.status === "not_modified") {
    return null
  }
  return googleProductsCatalogDirectory(result.json)
}

/** Fetches only "current"-kind documents and builds a complete catalog directory. */
async function fetchAdapterCatalogDirectory(
  source: ReturnType<typeof loadCatalogManifest>["sources"][number],
  args: Pick<LiveCatalogDirectoryArgs, "deadlineAtMs" | "nowMs">
): Promise<CatalogComponentDirectory | null> {
  const adapter = resolveAdapter(source.adapter)
  // One dispatcher per source so multi-page collection reuses the connection.
  // Closed in finally even when collection is incomplete or throws.
  const dispatcher = createProviderDispatcher()

  try {
    const collected = await collectAdapterDocuments({
      adapter,
      source,
      allowedKinds: ["current"],
      maxDocuments: MAX_CATALOG_DOCUMENTS_PER_SOURCE,
      deadlineAtMs: args.deadlineAtMs,
      nowMs: args.nowMs,
      skipOptionalFetchErrors: false,
      fetchDocument: (request, fetchOptions) =>
        fetchAdapterRequest(source, request, {
          dispatcher,
          deadlineAtMs: fetchOptions.deadlineAtMs,
        }),
    })

    // Cap or deadline mid-pagination is an incomplete directory. Catalog sync
    // must not treat partial component sets as drift (false outages).
    if (collected.status !== "complete") {
      return null
    }
    if (collected.documents.length === 0) {
      return null
    }

    const directory = adapter.catalogDirectory({
      source,
      documents: collected.documents,
    })
    // Adapters whose current documents cannot enumerate identity completely
    // (Google incidents) return complete:false. Treat that as unreachable for
    // catalog purposes so availability is not revised from a partial roster.
    if (!directory.complete) {
      return null
    }
    return directory
  } finally {
    await dispatcher.close()
  }
}

/**
 * Live fetcher that returns a complete CatalogComponentDirectory or null.
 * Accepts `{ source, deadlineAtMs, nowMs }` so maintenance and tests share
 * one call shape with an explicit wall-clock budget.
 */
export function createLiveCatalogDirectoryFetcher(
  manifest = loadCatalogManifest()
): FetchCatalogDirectory {
  const manifestBySourceId = new Map(
    manifest.sources.map((source) => [source.id, source])
  )

  return async (args) => {
    const manifestSource = manifestBySourceId.get(args.source.id)
    if (!manifestSource) {
      return null
    }

    try {
      if (manifestSource.adapter === "google_cloud_status") {
        const productsUrl = manifestSource.config.productsUrl
        if (typeof productsUrl !== "string") {
          return null
        }
        return await fetchGoogleProductsDirectory(
          manifestSource,
          productsUrl,
          args
        )
      }
      return await fetchAdapterCatalogDirectory(manifestSource, args)
    } catch {
      // A failed live fetch (network, parse, document cap, or deadline) records
      // FEED_UNREACHABLE on the source and touches no preset, per
      // reconcileCatalog's "feed failure never produces a false outage" rule.
      // Failed/timeout/oversized/malformed also leaves discovered scope
      // availability unchanged because materialization never runs.
      return null
    }
  }
}
