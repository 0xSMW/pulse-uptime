import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}));
vi.mock("@/lib/api/idempotency", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/idempotency")>()),
  executeIdempotent: vi.fn(async ({ work }: { work: (context: { operationId: string }) => Promise<{ status: number; body: unknown }> }) => ({
    ...(await work({ operationId: "op-1" })),
    replayed: false,
  })),
}));
vi.mock("@/lib/dependencies/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dependencies/service")>()),
  getDependencyDetail: vi.fn(),
  patchDependency: vi.fn(),
  removeDependency: vi.fn(),
}));

import { apiError } from "@/lib/api/envelopes";
import { authorize, type ApiContext } from "@/lib/api/middleware";
import { DependencyApiError, getDependencyDetail, patchDependency, removeDependency } from "@/lib/dependencies/service";

import { DELETE, GET, PATCH } from "./route";

const context: ApiContext = {
  principal: { type: "api_token", id: "tok-1", name: "agent", scopes: ["dependencies:read", "dependencies:write"], expiresAt: new Date() },
  principalKey: "api_token:tok-1",
  requestId: "req_dep",
};

const dependency = { id: "dep-1", catalogId: "vercel_runtime", name: "Vercel Runtime", provider: "Vercel", state: "OPERATIONAL" };
const params = { params: Promise.resolve({ dependencyId: "dep-1" }) };

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context);
  vi.mocked(getDependencyDetail).mockReset().mockResolvedValue(dependency as never);
  vi.mocked(patchDependency).mockReset().mockResolvedValue(dependency as never);
  vi.mocked(removeDependency).mockReset().mockResolvedValue({ id: "dep-1", removed: true });
});

describe("GET /api/v1/dependencies/{dependencyId}", () => {
  it("requires the dependencies:read scope and returns the Dependency envelope", async () => {
    const response = await GET(new Request("https://pulse.test/api/v1/dependencies/dep-1"), params);
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), { scope: "dependencies:read" });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.kind).toBe("Dependency");
    expect(payload.data).toEqual(dependency);
    expect(getDependencyDetail).toHaveBeenCalledWith("dep-1");
  });

  it("maps DEPENDENCY_NOT_FOUND to 404", async () => {
    vi.mocked(getDependencyDetail).mockRejectedValue(new DependencyApiError("DEPENDENCY_NOT_FOUND", "Dependency was not found"));
    const response = await GET(new Request("https://pulse.test/api/v1/dependencies/dep-1"), params);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("DEPENDENCY_NOT_FOUND");
  });

  it("returns the authorization failure untouched", async () => {
    vi.mocked(authorize).mockResolvedValue(apiError("req_denied", 403, "SCOPE_DENIED", "denied"));
    const response = await GET(new Request("https://pulse.test/api/v1/dependencies/dep-1"), params);
    expect(response.status).toBe(403);
    expect(getDependencyDetail).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/v1/dependencies/{dependencyId}", () => {
  function patchRequest(body: unknown) {
    return new Request("https://pulse.test/api/v1/dependencies/dep-1", {
      method: "PATCH",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
  }

  it("requires the dependencies:write scope and changes only notificationsEnabled", async () => {
    const response = await PATCH(patchRequest({ notificationsEnabled: false }), params);
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), { scope: "dependencies:write" });
    expect(response.status).toBe(200);
    expect(patchDependency).toHaveBeenCalledWith("dep-1", { notificationsEnabled: false });
    const payload = await response.json();
    expect(payload.kind).toBe("Dependency");
  });

  it("maps DEPENDENCY_NOT_FOUND to 404", async () => {
    vi.mocked(patchDependency).mockRejectedValue(new DependencyApiError("DEPENDENCY_NOT_FOUND", "Dependency was not found"));
    const response = await PATCH(patchRequest({ notificationsEnabled: false }), params);
    expect(response.status).toBe(404);
  });

  it("rejects invalid JSON bodies", async () => {
    const response = await PATCH(new Request("https://pulse.test/api/v1/dependencies/dep-1", {
      method: "PATCH",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: "{not json",
    }), params);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_JSON");
  });
});

describe("DELETE /api/v1/dependencies/{dependencyId}", () => {
  function deleteRequest() {
    return new Request("https://pulse.test/api/v1/dependencies/dep-1", {
      method: "DELETE",
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
  }

  it("requires the dependencies:write scope and returns 204 with no body", async () => {
    const response = await DELETE(deleteRequest(), params);
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), { scope: "dependencies:write" });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(removeDependency).toHaveBeenCalledWith("dep-1");
  });

  it("maps DEPENDENCY_NOT_FOUND to 404", async () => {
    vi.mocked(removeDependency).mockRejectedValue(new DependencyApiError("DEPENDENCY_NOT_FOUND", "Dependency was not found"));
    const response = await DELETE(deleteRequest(), params);
    expect(response.status).toBe(404);
  });
});
