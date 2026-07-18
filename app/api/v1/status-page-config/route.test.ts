import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
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
vi.mock("@/lib/api/status-page-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/status-page-config")>()),
  getStatusPageConfig: vi.fn(),
  putStatusPageConfig: vi.fn(),
}));

import { revalidatePath } from "next/cache";

import { apiError } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, type ApiContext } from "@/lib/api/middleware";
import {
  getStatusPageConfig,
  putStatusPageConfig,
  StatusPageConfigError,
} from "@/lib/api/status-page-config";

import { GET, PUT } from "./route";

const context: ApiContext = {
  principal: { type: "api_token", id: "tok-1", name: "agent", scopes: ["config:read", "config:write"], expiresAt: new Date() },
  principalKey: "api_token:tok-1",
  requestId: "req_status_page",
};

const data = { name: "Acme Status", historyDays: 90, updatedAt: "2026-07-18T00:00:00.000Z" };
// Distinct post-write updatedAt so the ETag the route derives from it
// (1784333900000) differs from the pre-write ETag above (1784332800000).
const updatedData = { name: "Acme Status", historyDays: 90, updatedAt: "2026-07-18T00:18:20.000Z" };

function getRequest() {
  return new Request("https://pulse.test/api/v1/status-page-config");
}

function putRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://pulse.test/api/v1/status-page-config", {
    method: "PUT",
    headers: { "Idempotency-Key": crypto.randomUUID(), ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(authorize).mockResolvedValue(context);
  vi.mocked(revalidatePath).mockReset();
  vi.mocked(executeIdempotent).mockClear();
  vi.mocked(getStatusPageConfig).mockReset().mockResolvedValue({ data: data as never, etag: '"1784332800000"' });
  vi.mocked(putStatusPageConfig).mockReset().mockResolvedValue({ data: updatedData as never, etag: '"1784333900000"' });
});

describe("GET /api/v1/status-page-config", () => {
  it("requires the config:read scope", async () => {
    await GET(getRequest());
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), { scope: "config:read" });
  });

  it("returns the authorization failure untouched", async () => {
    vi.mocked(authorize).mockResolvedValue(apiError("req_denied", 403, "SCOPE_DENIED", "denied"));
    const response = await GET(getRequest());
    expect(response.status).toBe(403);
    expect(getStatusPageConfig).not.toHaveBeenCalled();
  });

  it("returns the envelope with the ETag response header", async () => {
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe('"1784332800000"');
    const payload = await response.json();
    expect(payload.kind).toBe("StatusPageConfig");
    expect(payload.apiVersion).toBe("v1");
    expect(payload.data).toEqual(data);
    expect(payload.meta.requestId).toBe("req_status_page");
  });

  it("maps a missing seed row to 503", async () => {
    vi.mocked(getStatusPageConfig).mockRejectedValue(new StatusPageConfigError("CONFIG_UNAVAILABLE", "missing"));
    const response = await GET(getRequest());
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload.error.code).toBe("CONFIG_UNAVAILABLE");
  });
});

describe("PUT /api/v1/status-page-config", () => {
  it("requires the config:write scope", async () => {
    await PUT(putRequest({}, { "If-Match": '"0"' }));
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), { scope: "config:write" });
  });

  it("returns 428 PRECONDITION_REQUIRED when If-Match is missing", async () => {
    const response = await PUT(putRequest({ name: "X" }));
    expect(response.status).toBe(428);
    const payload = await response.json();
    expect(payload.error.code).toBe("PRECONDITION_REQUIRED");
    expect(putStatusPageConfig).not.toHaveBeenCalled();
  });

  it("threads the body and If-Match into the service and returns the ETag derived from the new updatedAt", async () => {
    const response = await PUT(putRequest({ name: "Acme Status" }, { "If-Match": '"1784332800000"' }));
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe('"1784333900000"');
    expect(putStatusPageConfig).toHaveBeenCalledWith({ name: "Acme Status" }, '"1784332800000"');
    const payload = await response.json();
    expect(payload.kind).toBe("StatusPageConfig");
  });

  it("revalidates every public status route on a successful save (finding: ISR pages and image refs go stale otherwise)", async () => {
    await PUT(putRequest({ name: "Acme Status" }, { "If-Match": '"1784332800000"' }));
    expect(revalidatePath).toHaveBeenCalledWith("/status", "layout");
    expect(revalidatePath).toHaveBeenCalledTimes(1);
  });

  it("replays a stored response for a reused Idempotency-Key instead of re-executing the write (finding: spurious 412 on a lost-response retry)", async () => {
    vi.mocked(executeIdempotent).mockResolvedValueOnce({
      status: 200,
      body: updatedData as never,
      replayed: true,
    });
    const response = await PUT(putRequest({ name: "Acme Status" }, { "If-Match": '"1784332800000"' }));
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe('"1784333900000"');
    expect(putStatusPageConfig).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does not revalidate when the write fails", async () => {
    vi.mocked(putStatusPageConfig).mockRejectedValue(
      new StatusPageConfigError("PRECONDITION_FAILED", "changed since read"),
    );
    await PUT(putRequest({}, { "If-Match": '"9"' }));
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("maps an ETag mismatch to 412 PRECONDITION_FAILED", async () => {
    vi.mocked(putStatusPageConfig).mockRejectedValue(
      new StatusPageConfigError("PRECONDITION_FAILED", "changed since read"),
    );
    const response = await PUT(putRequest({}, { "If-Match": '"9"' }));
    expect(response.status).toBe(412);
    const payload = await response.json();
    expect(payload.error.code).toBe("PRECONDITION_FAILED");
  });

  it("maps validation and image-reference failures to 400", async () => {
    vi.mocked(putStatusPageConfig).mockRejectedValue(
      new StatusPageConfigError("IMAGE_REFERENCE_INVALID", "bad image", { field: "faviconImageId" }),
    );
    const response = await PUT(putRequest({}, { "If-Match": '"0"' }));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("IMAGE_REFERENCE_INVALID");
    expect(payload.error.details).toEqual({ field: "faviconImageId" });
  });

  it("rejects invalid JSON bodies", async () => {
    const request = new Request("https://pulse.test/api/v1/status-page-config", {
      method: "PUT",
      headers: { "If-Match": '"0"', "Idempotency-Key": crypto.randomUUID() },
      body: "{not json",
    });
    const response = await PUT(request);
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("INVALID_JSON");
  });
});
