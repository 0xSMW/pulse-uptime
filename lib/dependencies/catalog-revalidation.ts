import "server-only";

import { resolveAdapter, type AdapterDocument } from "./adapters";
import type { CatalogComponentDirectory, FetchSourceComponents } from "./catalog-sync";
import { fetchProviderDocument } from "./fetch";
import { loadCatalogManifest } from "./manifest";

// The live fetcher reconcileCatalog needs to confirm a source's feed still
// exposes every id its enabled presets select. Google Cloud is the one
// adapter that can't answer this from its own normalize() output: its
// components map only ever holds products with an active incident right
// now (see adapters/google-cloud-status.ts), so a quiet product would look
// like drift. Its manifest config carries a separate productsUrl for
// exactly this case. Every other adapter answers from its own "current"
// documents, fetched read-only and never persisted.

/**
 * The live products.json carries its roster as a { products: [...] } object,
 * and each product's id is what google_product selectors match on. A bare
 * top-level array is also accepted, so both the wrapper shape and a raw list
 * yield the same product ids.
 */
function googleProductsArray(json: unknown): unknown[] | null {
  if (Array.isArray(json)) return json;
  if (json !== null && typeof json === "object" && Array.isArray((json as { products?: unknown }).products)) {
    return (json as { products: unknown[] }).products;
  }
  return null;
}

async function fetchGoogleProductIds(
  sourceId: string,
  allowedHosts: readonly string[],
  productsUrl: string,
): Promise<CatalogComponentDirectory | null> {
  const result = await fetchProviderDocument({ id: sourceId, allowedHosts }, { url: productsUrl });
  if (result.status === "not_modified") return null;
  const products = googleProductsArray(result.json);
  if (!products) return null;
  const ids = products
    .map((entry) => (typeof entry === "object" && entry !== null && "id" in entry ? String((entry as { id: unknown }).id) : null))
    .filter((id): id is string => Boolean(id));
  return { componentIds: new Set(ids) };
}

/** Fetches only "current"-kind documents (and their own pagination follow-ups): validation needs component identity, never incidents or maintenance. */
async function fetchCurrentComponentIds(
  source: ReturnType<typeof loadCatalogManifest>["sources"][number],
): Promise<CatalogComponentDirectory | null> {
  const adapter = resolveAdapter(source.adapter);
  const documents: AdapterDocument[] = [];

  while (true) {
    const requests = adapter.requests(source, documents.length > 0 ? documents : undefined)
      .filter((request) => request.kind === "current");
    const pending = requests.filter((request) => !documents.some((document) => document.url === request.url));
    if (pending.length === 0) break;

    for (const request of pending) {
      const result = await fetchProviderDocument({ id: source.id, allowedHosts: source.allowedHosts }, { url: request.url });
      if (result.status === "not_modified") continue;
      documents.push({ kind: request.kind, url: request.url, json: result.json, text: result.text });
    }
  }

  if (documents.length === 0) return null;
  const snapshot = adapter.normalize({ source, documents, observedAt: new Date().toISOString() });
  return { componentIds: new Set(Object.keys(snapshot.components)) };
}

export function createLiveFetchSourceComponents(manifest = loadCatalogManifest()): FetchSourceComponents {
  const manifestBySourceId = new Map(manifest.sources.map((source) => [source.id, source]));

  return async (source) => {
    const manifestSource = manifestBySourceId.get(source.id);
    if (!manifestSource) return null;

    try {
      if (manifestSource.adapter === "google_cloud_status") {
        const productsUrl = manifestSource.config.productsUrl;
        if (typeof productsUrl !== "string") return null;
        return await fetchGoogleProductIds(source.id, manifestSource.allowedHosts, productsUrl);
      }
      return await fetchCurrentComponentIds(manifestSource);
    } catch {
      // A failed live fetch records FEED_UNREACHABLE on the source and
      // touches no preset, per reconcileCatalog's "feed failure never
      // produces a false outage" rule.
      return null;
    }
  };
}
