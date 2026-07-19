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
  executeIdempotent: vi.fn(async ({ work }: {
    work: (context: { operationId: string; transaction: <R>(run: (tx: unknown) => Promise<R>) => Promise<R> }) => Promise<{ status: number; body: unknown }>;
  }) => ({
    ...(await work({ operationId: "op-1", transaction: async (run) => run("stub-tx") })),
    replayed: false,
  })),
}));
vi.mock("@/lib/api/status-page-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/status-page-config")>()),
  getStatusPageConfig: vi.fn(),
  putStatusPageConfig: vi.fn(),
}));

import { revalidatePath } from "next/cache";

import { apiError, errorEnvelope } from "@/lib/api/envelopes";
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

const data = { name: "Acme Status", historyDays: 90, updatedAt: "2026-07-18T00:00:00.000Z", version: 5 };
// Distinct post-write version so the ETag the route derives from it (via
// etagFor, which reads data.version, not data.updatedAt) differs from the
// pre-write ETag above.
const updatedData = { name: "Acme Status", historyDays: 90, updatedAt: "2026-07-18T00:18:20.000Z", version: 6 };

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
  vi.mocked(getStatusPageConfig).mockReset().mockResolvedValue({ data: data as never, etag: '"5"' });
  vi.mocked(putStatusPageConfig).mockReset().mockResolvedValue({ data: updatedData as never, etag: '"6"' });
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
    expect(response.headers.get("ETag")).toBe('"5"');
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

  it("folds If-Match into the idempotency fingerprint, not just the document (finding: executeIdempotent hashes only the `body` value it's given, together with method/path/query — a key reused with the SAME document but a FRESH If-Match, e.g. re-read after a 412 and resubmitted under the same key, must hash differently so it surfaces IDEMPOTENCY_KEY_REUSED instead of replaying the first attempt's stored response)", async () => {
    await PUT(putRequest({ name: "Acme Status" }, { "If-Match": '"5"' }));
    const firstBody = (vi.mocked(executeIdempotent).mock.calls[0][0] as { body: unknown }).body;
    expect(firstBody).toEqual({ ifMatch: '"5"', document: { name: "Acme Status" } });

    vi.mocked(executeIdempotent).mockClear();
    await PUT(putRequest({ name: "Acme Status" }, { "If-Match": '"6"' }));
    const secondBody = (vi.mocked(executeIdempotent).mock.calls[0][0] as { body: unknown }).body;
    expect(secondBody).toEqual({ ifMatch: '"6"', document: { name: "Acme Status" } });

    // Same document, different If-Match: the two fingerprints must differ.
    expect(secondBody).not.toEqual(firstBody);

    // work() must still see the RAW body/If-Match, unaffected by the
    // composite fingerprint value.
    expect(putStatusPageConfig).toHaveBeenCalledWith({ name: "Acme Status" }, '"6"', { handle: "stub-tx" });
  });

  it("threads the body and If-Match into the service and returns the ETag derived from the new version", async () => {
    const response = await PUT(putRequest({ name: "Acme Status" }, { "If-Match": '"5"' }));
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe('"6"');
    expect(putStatusPageConfig).toHaveBeenCalledWith({ name: "Acme Status" }, '"5"', { handle: "stub-tx" });
    const payload = await response.json();
    expect(payload.kind).toBe("StatusPageConfig");
  });

  it("wraps the write in context.transaction and threads the tx handle into putStatusPageConfig (finding: a fallback post-hoc completion write could commit after the guarded UPDATE crashed, leaving the two inconsistent)", async () => {
    await PUT(putRequest({ name: "Acme Status" }, { "If-Match": '"5"' }));
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      work: (context: { operationId: string; transaction: <R>(run: (tx: unknown) => Promise<R>) => Promise<R> }) => Promise<{ status: number; body: unknown }>;
    };
    await options.work({ operationId: "op-2", transaction: async (run) => run("captured-tx") });
    // The mock resolves putStatusPageConfig itself, so assert on the handle
    // that reached it directly rather than re-deriving it from the response.
    expect(vi.mocked(putStatusPageConfig).mock.calls.at(-1)?.[2]).toEqual({ handle: "captured-tx" });
  });

  it("revalidates every public status route on a successful save (finding: ISR pages and image refs go stale otherwise)", async () => {
    await PUT(putRequest({ name: "Acme Status" }, { "If-Match": '"5"' }));
    expect(revalidatePath).toHaveBeenCalledWith("/status", "layout");
    expect(revalidatePath).toHaveBeenCalledTimes(1);
  });

  it("replays a stored response for a reused Idempotency-Key instead of re-executing the write (finding: spurious 412 on a lost-response retry)", async () => {
    vi.mocked(executeIdempotent).mockResolvedValueOnce({
      status: 200,
      body: updatedData as never,
      replayed: true,
    });
    const response = await PUT(putRequest({ name: "Acme Status" }, { "If-Match": '"5"' }));
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe('"6"');
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

  it("a genuinely stale If-Match with a genuinely DIFFERENT body still 412s via work()'s conditional UPDATE", async () => {
    vi.mocked(putStatusPageConfig).mockRejectedValue(
      new StatusPageConfigError("PRECONDITION_FAILED", "changed since read"),
    );
    const response = await PUT(putRequest({ name: "Someone Else's Edit" }, { "If-Match": '"5"' }));
    expect(response.status).toBe(412);
    expect((await response.json()).error.code).toBe("PRECONDITION_FAILED");
  });

  it("maps a StatusPageConfigError inside work() itself, not thrown past executeIdempotent (finding: a thrown 412 left the idempotency record stuck 'running' instead of completed)", async () => {
    vi.mocked(putStatusPageConfig).mockRejectedValue(
      new StatusPageConfigError("PRECONDITION_FAILED", "changed since read"),
    );
    await PUT(putRequest({}, { "If-Match": '"9"' }));
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      work: (context: { operationId: string; transaction: <R>(run: (tx: unknown) => Promise<R>) => Promise<R> }) => Promise<{ status: number; body: unknown }>;
    };
    await expect(options.work({ operationId: "op-1", transaction: async (run) => run("stub-tx") })).resolves.toEqual({
      status: 412,
      body: errorEnvelope("PRECONDITION_FAILED", "changed since read", "req_status_page", {}),
    });
  });
});
