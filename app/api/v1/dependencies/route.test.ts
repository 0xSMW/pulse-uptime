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
  installDependency: vi.fn(),
  listDependencies: vi.fn(),
  recoverInstalledDependency: vi.fn(),
}));

import { apiError, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, type ApiContext } from "@/lib/api/middleware";
import { DependencyApiError, installDependency, listDependencies, recoverInstalledDependency } from "@/lib/dependencies/service";

import { GET, POST } from "./route";

const context: ApiContext = {
  principal: { type: "api_token", id: "tok-1", name: "agent", scopes: ["dependencies:read", "dependencies:write"], expiresAt: new Date() },
  principalKey: "api_token:tok-1",
  requestId: "req_deps",
};

const dependency = { id: "dep-1", catalogId: "vercel_runtime", name: "Vercel Runtime", provider: "Vercel", state: "UNKNOWN" };

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context);
  vi.mocked(listDependencies).mockReset().mockResolvedValue([dependency] as never);
  vi.mocked(installDependency).mockReset().mockResolvedValue(dependency as never);
  vi.mocked(recoverInstalledDependency).mockReset();
  vi.mocked(executeIdempotent).mockClear();
});

describe("GET /api/v1/dependencies", () => {
  it("requires the dependencies:read scope and returns the list envelope", async () => {
    const response = await GET(new Request("https://pulse.test/api/v1/dependencies"));
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), { scope: "dependencies:read" });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.kind).toBe("DependencyList");
    expect(payload.data).toEqual([dependency]);
    expect(payload.meta).toEqual({ requestId: "req_deps", nextCursor: null });
  });

  it("returns the authorization failure untouched", async () => {
    vi.mocked(authorize).mockResolvedValue(apiError("req_denied", 403, "SCOPE_DENIED", "denied"));
    const response = await GET(new Request("https://pulse.test/api/v1/dependencies"));
    expect(response.status).toBe(403);
    expect(listDependencies).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/dependencies", () => {
  function postRequest(body: unknown) {
    return new Request("https://pulse.test/api/v1/dependencies", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
  }

  it("requires the dependencies:write scope and returns 201 with the Dependency envelope", async () => {
    const response = await POST(postRequest({ presetId: "vercel_runtime" }));
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), { scope: "dependencies:write" });
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.kind).toBe("Dependency");
    expect(payload.data).toEqual(dependency);
  });

  it("never accepts a URL or upstream component id, only presetId/scopeId/notificationsEnabled", async () => {
    const response = await POST(postRequest({ presetId: "vercel_runtime", url: "https://vercel.com", componentId: "abc" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_REQUEST");
    expect(installDependency).not.toHaveBeenCalled();
  });

  it("rejects a missing presetId", async () => {
    const response = await POST(postRequest({}));
    expect(response.status).toBe(400);
    expect(installDependency).not.toHaveBeenCalled();
  });

  it("pins the dependency id to the idempotency operationId", async () => {
    await POST(postRequest({ presetId: "vercel_runtime" }));
    expect(installDependency).toHaveBeenCalledWith({ presetId: "vercel_runtime" }, { dependencyId: "op-1" });
  });

  it("wires recover + rerunAfterRecoveryMiss: false for crash-recovery replay", async () => {
    await POST(postRequest({ presetId: "vercel_runtime" }));
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<unknown>;
      rerunAfterRecoveryMiss: boolean;
    };
    expect(options.rerunAfterRecoveryMiss).toBe(false);

    vi.mocked(recoverInstalledDependency).mockResolvedValue(dependency as never);
    await expect(options.recover({ operationId: "op-99" })).resolves.toEqual({
      status: 201,
      body: objectEnvelope("Dependency", dependency, context.requestId),
    });
    expect(recoverInstalledDependency).toHaveBeenCalledWith("op-99");

    vi.mocked(recoverInstalledDependency).mockResolvedValue(null);
    await expect(options.recover({ operationId: "op-100" })).resolves.toBeNull();
  });

  it("maps PRESET_NOT_FOUND to 400", async () => {
    vi.mocked(installDependency).mockRejectedValue(new DependencyApiError("PRESET_NOT_FOUND", "Preset was not found"));
    const response = await POST(postRequest({ presetId: "nope" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("PRESET_NOT_FOUND");
  });

  it("maps DEPENDENCY_EXISTS to 409", async () => {
    vi.mocked(installDependency).mockRejectedValue(new DependencyApiError("DEPENDENCY_EXISTS", "Already installed"));
    const response = await POST(postRequest({ presetId: "vercel_runtime" }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("DEPENDENCY_EXISTS");
  });

  it("maps SCOPE_REQUIRED to 400", async () => {
    vi.mocked(installDependency).mockRejectedValue(new DependencyApiError("SCOPE_REQUIRED", "scopeId required"));
    const response = await POST(postRequest({ presetId: "neon_database" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("SCOPE_REQUIRED");
  });

  it("rejects invalid JSON bodies", async () => {
    const response = await POST(new Request("https://pulse.test/api/v1/dependencies", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: "{not json",
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_JSON");
  });
});
