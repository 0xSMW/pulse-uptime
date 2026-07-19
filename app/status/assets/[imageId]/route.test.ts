import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db: {} }));

import { databaseImageStore, type StoredImage } from "@/lib/api/images";

import { GET } from "./route";

const IMAGE_ID = "66666666-6666-4666-8666-666666666666";

function stored(overrides: Partial<StoredImage> = {}): StoredImage {
  return {
    id: IMAGE_ID,
    kind: "logo-light",
    mimeType: "image/png",
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    byteSize: 4,
    ...overrides,
  };
}

function assetRequest(id = IMAGE_ID) {
  return GET(new Request(`https://pulse.test/status/assets/${id}`), { params: Promise.resolve({ imageId: id }) });
}

beforeEach(() => {
  vi.spyOn(databaseImageStore, "find").mockResolvedValue(stored());
});

describe("GET /status/assets/{imageId}", () => {
  it("serves logo kinds with immutable CDN cache headers", async () => {
    const response = await assetRequest();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, s-maxage=31536000, immutable");
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Disposition")).toBe("inline");
    expect(response.headers.get("Content-Length")).toBe("4");
  });

  it("serves dark logos too", async () => {
    vi.mocked(databaseImageStore.find).mockResolvedValue(stored({ kind: "logo-dark" }));
    expect((await assetRequest()).status).toBe(200);
  });

  it("sandboxes SVG logos with a strict Content-Security-Policy", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    vi.mocked(databaseImageStore.find).mockResolvedValue(
      stored({ mimeType: "image/svg+xml", bytes: svg, byteSize: svg.length }),
    );
    const response = await assetRequest();
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("never serves avatars publicly", async () => {
    vi.mocked(databaseImageStore.find).mockResolvedValue(stored({ kind: "avatar" }));
    expect((await assetRequest()).status).toBe(404);
  });

  it("never serves favicons publicly (they are inlined by the page)", async () => {
    vi.mocked(databaseImageStore.find).mockResolvedValue(stored({ kind: "favicon" }));
    expect((await assetRequest()).status).toBe(404);
  });

  it("returns an uncached 404 for unknown or malformed ids", async () => {
    vi.mocked(databaseImageStore.find).mockResolvedValue(null);
    const missing = await assetRequest();
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");

    vi.mocked(databaseImageStore.find).mockClear();
    expect((await assetRequest("../secrets")).status).toBe(404);
    expect(databaseImageStore.find).not.toHaveBeenCalled();
  });
});
