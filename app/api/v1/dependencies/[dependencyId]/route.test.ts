import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}));
// Mirrors executeIdempotent's real completion semantics: work() runs inside
// transaction(), and a key only records its outcome if run() resolves. A
// thrown run() records nothing, proving the mutation rolled back. A repeated
// key replays the stored outcome without re-running the work.
const idempotencyRecords = new Map<string, { status: number; body: unknown }>();
vi.mock("@/lib/api/idempotency", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/idempotency")>()),
  executeIdempotent: vi.fn(async ({ request, work }: {
    request: Request;
    work: (context: {
      operationId: string;
      transaction: (run: (tx: unknown) => Promise<{ status: number; body: unknown }>) => Promise<{ status: number; body: unknown }>;
    }) => Promise<{ status: number; body: unknown }>;
  }) => {
    const key = request.headers.get("idempotency-key")!;
    const existing = idempotencyRecords.get(key);
    if (existing) return { ...existing, replayed: true };
    const result = await work({
      operationId: "op-1",
      transaction: async (run) => {
        const outcome = await run("tx");
        idempotencyRecords.set(key, outcome);
        return outcome;
      },
    });
    return { ...result, replayed: false };
  }),
}));
vi.mock("@/lib/dependencies/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dependencies/service")>()),
  requireDependencyDetail: vi.fn(),
  patchDependency: vi.fn(),
  removeDependency: vi.fn(),
}));

import { apiError } from "@/lib/api/envelopes";
import { authorize, type ApiContext } from "@/lib/api/middleware";
import { DependencyApiError, requireDependencyDetail, patchDependency, removeDependency } from "@/lib/dependencies/service";

import { DELETE, GET, PATCH } from "./route";

const context: ApiContext = {
  principal: { type: "api_token", id: "tok-1", name: "agent", scopes: ["dependencies:read", "dependencies:write"], expiresAt: new Date() },
  principalKey: "api_token:tok-1",
  requestId: "req_dep",
};

const dependency = { id: "dep-1", presetId: "vercel_runtime", name: "Vercel Runtime", provider: "Vercel", state: "OPERATIONAL" };
const params = { params: Promise.resolve({ dependencyId: "dep-1" }) };

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context);
  vi.mocked(requireDependencyDetail).mockReset().mockResolvedValue(dependency as never);
  vi.mocked(patchDependency).mockReset().mockResolvedValue(dependency as never);
  vi.mocked(removeDependency).mockReset().mockResolvedValue({ id: "dep-1", removed: true });
  idempotencyRecords.clear();
});

describe("GET /api/v1/dependencies/{dependencyId}", () => {
  it("requires the dependencies:read scope and returns the Dependency envelope", async () => {
    const response = await GET(new Request("https://pulse.test/api/v1/dependencies/dep-1"), params);
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), { scope: "dependencies:read" });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.kind).toBe("Dependency");
    expect(payload.data).toEqual(dependency);
    expect(requireDependencyDetail).toHaveBeenCalledWith("dep-1");
  });

  it("maps DEPENDENCY_NOT_FOUND to 404", async () => {
    vi.mocked(requireDependencyDetail).mockRejectedValue(new DependencyApiError("DEPENDENCY_NOT_FOUND", "Dependency was not found"));
    const response = await GET(new Request("https://pulse.test/api/v1/dependencies/dep-1"), params);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("DEPENDENCY_NOT_FOUND");
  });

  it("returns the authorization failure untouched", async () => {
    vi.mocked(authorize).mockResolvedValue(apiError("req_denied", 403, "SCOPE_DENIED", "denied"));
    const response = await GET(new Request("https://pulse.test/api/v1/dependencies/dep-1"), params);
    expect(response.status).toBe(403);
    expect(requireDependencyDetail).not.toHaveBeenCalled();
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
    expect(patchDependency).toHaveBeenCalledWith("dep-1", { notificationsEnabled: false }, {}, "tx");
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
    expect(removeDependency).toHaveBeenCalledWith("dep-1", {}, "tx");
  });

  it("removes inside the idempotency transaction so the removal and the record commit together", async () => {
    await DELETE(deleteRequest(), params);
    expect(removeDependency).toHaveBeenCalledWith("dep-1", {}, "tx");
  });

  it("replays a stored 204 for a repeated key instead of re-running, so an already-removed dependency never 404s on replay", async () => {
    const request = deleteRequest();
    const first = await DELETE(request.clone(), params);
    expect(first.status).toBe(204);
    expect(removeDependency).toHaveBeenCalledTimes(1);
    const replay = await DELETE(request, params);
    expect(replay.status).toBe(204);
    expect(await replay.text()).toBe("");
    expect(removeDependency).toHaveBeenCalledTimes(1);
  });

  it("maps DEPENDENCY_NOT_FOUND to 404 for a fresh key on an already-absent dependency", async () => {
    vi.mocked(removeDependency).mockRejectedValue(new DependencyApiError("DEPENDENCY_NOT_FOUND", "Dependency was not found"));
    const response = await DELETE(deleteRequest(), params);
    expect(response.status).toBe(404);
  });
});
