import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { fetchProviderDocument } = vi.hoisted(() => ({ fetchProviderDocument: vi.fn() }));
vi.mock("./fetch", () => ({ fetchProviderDocument }));

import { createLiveFetchSourceComponents } from "./catalog-revalidation";
import { loadCatalogManifest } from "./manifest";

const manifest = loadCatalogManifest();

beforeEach(() => {
  fetchProviderDocument.mockReset();
});

describe("createLiveFetchSourceComponents", () => {
  it("returns null for a source no longer present in the manifest", async () => {
    const fetcher = createLiveFetchSourceComponents(manifest);
    const result = await fetcher({ id: "not-a-real-source", adapter: "statuspage_v2", currentUrl: "https://example.com" });
    expect(result).toBeNull();
    expect(fetchProviderDocument).not.toHaveBeenCalled();
  });

  it("fetches Google Cloud's products.json and collects product ids, bypassing incidents.json", async () => {
    fetchProviderDocument.mockResolvedValueOnce({
      status: "ok",
      statusCode: 200,
      json: [{ id: "prod-1", display_name: "Cloud Run" }, { id: "prod-2", display_name: "Cloud SQL" }],
      etag: null,
      lastModified: null,
    });
    const fetcher = createLiveFetchSourceComponents(manifest);
    const source = manifest.sources.find((entry) => entry.id === "google_cloud")!;
    const result = await fetcher({ id: source.id, adapter: source.adapter, currentUrl: source.currentUrl });

    expect(result).toEqual({ componentIds: new Set(["prod-1", "prod-2"]) });
    expect(fetchProviderDocument).toHaveBeenCalledTimes(1);
    const [, request] = fetchProviderDocument.mock.calls[0]!;
    expect(request.url).toBe(source.config.productsUrl);
  });

  it("returns null when Google's products response is not modified or not an array", async () => {
    fetchProviderDocument.mockResolvedValueOnce({ status: "not_modified", etag: null, lastModified: null });
    const fetcher = createLiveFetchSourceComponents(manifest);
    const source = manifest.sources.find((entry) => entry.id === "google_cloud")!;
    const result = await fetcher({ id: source.id, adapter: source.adapter, currentUrl: source.currentUrl });
    expect(result).toBeNull();
  });

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
      etag: "\"v1\"",
      lastModified: null,
    });
    const fetcher = createLiveFetchSourceComponents(manifest);
    const source = manifest.sources.find((entry) => entry.id === "anthropic")!;
    const result = await fetcher({ id: source.id, adapter: source.adapter, currentUrl: source.currentUrl });

    expect(result).toEqual({ componentIds: new Set(["comp-1"]) });
    // Only the primary summary document is fetched: no incidents.json, no maintenance route.
    expect(fetchProviderDocument).toHaveBeenCalledTimes(1);
    const [, request] = fetchProviderDocument.mock.calls[0]!;
    expect(request.url).toBe(source.currentUrl);
  });

  it("returns null and records no drift when the live fetch fails", async () => {
    fetchProviderDocument.mockRejectedValueOnce(new Error("network down"));
    const fetcher = createLiveFetchSourceComponents(manifest);
    const source = manifest.sources.find((entry) => entry.id === "anthropic")!;
    const result = await fetcher({ id: source.id, adapter: source.adapter, currentUrl: source.currentUrl });
    expect(result).toBeNull();
  });

  it("drives sorry_v1 pagination across current-kind documents only", async () => {
    const source = manifest.sources.find((entry) => entry.id === "postmark")!;
    const componentsUrl = source.config.componentsUrl as string;
    fetchProviderDocument.mockResolvedValueOnce({
      status: "ok",
      statusCode: 200,
      json: { components: [{ id: 1, name: "API", state: "operational" }], meta: { count: 1, total_count: 2, next_page: "/api/v1/components?page=2" } },
      etag: null,
      lastModified: null,
    }).mockResolvedValueOnce({
      status: "ok",
      statusCode: 200,
      json: { components: [{ id: 2, name: "SMTP", state: "degraded" }], meta: { count: 1, total_count: 2, next_page: null } },
      etag: null,
      lastModified: null,
    });
    const fetcher = createLiveFetchSourceComponents(manifest);
    const result = await fetcher({ id: source.id, adapter: source.adapter, currentUrl: source.currentUrl });

    expect(result).toEqual({ componentIds: new Set(["1", "2"]) });
    expect(fetchProviderDocument).toHaveBeenCalledTimes(2);
    const urls = fetchProviderDocument.mock.calls.map((call) => call[1].url);
    expect(urls[0]).toBe(componentsUrl);
    expect(urls[1]).toContain("page=2");
  });
});
