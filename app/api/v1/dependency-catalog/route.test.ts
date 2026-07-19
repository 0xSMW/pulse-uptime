import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}));
vi.mock("@/lib/dependencies/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dependencies/service")>()),
  listCatalog: vi.fn(),
}));

import { apiError } from "@/lib/api/envelopes";
import { authorize, type ApiContext } from "@/lib/api/middleware";
import { listCatalog } from "@/lib/dependencies/service";

import { GET } from "./route";

const context: ApiContext = {
  principal: { type: "api_token", id: "tok-1", name: "agent", scopes: ["dependencies:read"], expiresAt: new Date() },
  principalKey: "api_token:tok-1",
  requestId: "req_catalog",
};

const categories = [
  {
    category: "hosting",
    presets: [
      { id: "vercel_runtime", name: "Vercel Runtime", provider: "Vercel", description: "Functions, CDN, routing, DNS.", scope: null, sourceScopeNote: null, enabled: true, validated: true, installed: false, installedScopeIds: [] },
    ],
  },
];

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context);
  vi.mocked(listCatalog).mockReset().mockResolvedValue(categories);
});

describe("GET /api/v1/dependency-catalog", () => {
  it("requires the dependencies:read scope", async () => {
    await GET(new Request("https://pulse.test/api/v1/dependency-catalog"));
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), { scope: "dependencies:read" });
  });

  it("returns the authorization failure untouched", async () => {
    vi.mocked(authorize).mockResolvedValue(apiError("req_denied", 403, "SCOPE_DENIED", "denied"));
    const response = await GET(new Request("https://pulse.test/api/v1/dependency-catalog"));
    expect(response.status).toBe(403);
    expect(listCatalog).not.toHaveBeenCalled();
  });

  it("returns the catalog grouped by category under the DependencyCatalog envelope", async () => {
    const response = await GET(new Request("https://pulse.test/api/v1/dependency-catalog"));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.kind).toBe("DependencyCatalog");
    expect(payload.apiVersion).toBe("v1");
    expect(payload.data).toEqual({ categories });
    expect(payload.meta).toEqual({ requestId: "req_catalog" });
  });
});
