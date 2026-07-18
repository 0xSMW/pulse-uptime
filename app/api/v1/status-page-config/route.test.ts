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

const data = { name: "Acme Status", historyDays: 90, updatedAt: "2026-07-18T00:00:00.000Z" };
// Distinct post-write updatedAt so the ETag the route derives from it
// (1784333900000) differs from the pre-write ETag above (1784332800000).
const updatedData = { name: "Acme Status", historyDays: 90, updatedAt: "2026-07-18T00:18:20.000Z" };

function getRequest() {
  return new Request("https://pulse.test/api/v1/status-page-config");
}

/** A full document satisfying the strict schema, for tests that exercise the real parseStatusPageConfigDocument. */
function fullDocument(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    name: "Acme Status",
    layout: "vertical",
    theme: "system",
    logoLightImageId: null,
    logoDarkImageId: null,
    faviconImageId: null,
    homepageUrl: null,
    contactUrl: null,
    navLinks: [],
    googleTagId: null,
    customCss: null,
    customHead: null,
    announcementEnabled: false,
    announcementMarkdown: null,
    historyDays: 90,
    uptimeDecimals: 1,
    unknownAsOperational: false,
    minIncidentSeconds: 0,
    timezone: null,
    ...overrides,
  };
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

  it("wires a recover callback that returns the current document as success when the retry's own If-Match is FRESH against the current ETag and the document already matches what was submitted (finding: a committed save + crash makes the retry 412 against its own write; a well-behaved client refreshes If-Match before retrying under the same Idempotency-Key, which If-Match isn't part of, so this is exactly how a genuine crash-after-commit retry looks)", async () => {
    const submitted = fullDocument({ name: "Acme Status" });
    await PUT(putRequest(submitted, { "If-Match": '"1784332800000"' }));
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<{ status: number; body: unknown } | null>;
    };

    // Recovery hit: this retry's own If-Match ("1784332800000") matches the
    // CURRENT etag, and the current document already deep-equals what was
    // submitted — a prior attempt committed the write before crashing — so
    // the retry recovers with the current state instead of rerunning
    // putStatusPageConfig.
    vi.mocked(getStatusPageConfig).mockResolvedValue({
      data: { ...submitted, updatedAt: "2026-07-18T00:00:00.000Z" } as never,
      etag: '"1784332800000"',
    });
    await expect(options.recover({ operationId: "op-1" })).resolves.toEqual({
      status: 200,
      body: { ...submitted, updatedAt: "2026-07-18T00:00:00.000Z" },
    });

    // Recovery miss: the current document genuinely differs (the crash hit
    // before the write committed, or something else changed it since) — fall
    // through so work() reruns the real If-Match-guarded write.
    vi.mocked(getStatusPageConfig).mockResolvedValue({
      data: { ...submitted, name: "Something Else", updatedAt: "2026-07-18T00:00:00.000Z" } as never,
      etag: '"1784332800000"',
    });
    await expect(options.recover({ operationId: "op-1" })).resolves.toBeNull();
  });

  it("returns null (never a recovered 200) when this retry's If-Match is STALE against the current ETag, even if the current document coincidentally already matches what was submitted (finding: someone else making the identical edit must not mask a genuine precondition failure — recover must not manufacture success just because the resulting content looks the same; work() reruns and reproduces the real 412)", async () => {
    const submitted = fullDocument({ name: "Acme Status" });
    await PUT(putRequest(submitted, { "If-Match": '"1784332800000"' }));
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<{ status: number; body: unknown } | null>;
    };

    // Current ETag has moved on to "1784333900000" — someone else's write —
    // while this retry still carries the ORIGINAL, now-stale If-Match
    // ("1784332800000"). The document coincidentally matches, but that must
    // not be treated as this operation's own success.
    vi.mocked(getStatusPageConfig).mockResolvedValue({
      data: { ...submitted, updatedAt: "2026-07-18T00:18:20.000Z" } as never,
      etag: '"1784333900000"',
    });
    await expect(options.recover({ operationId: "op-1" })).resolves.toBeNull();
  });

  it("recover ignores field order and the read-only updatedAt when comparing documents (with a fresh If-Match)", async () => {
    const submitted = fullDocument({ name: "Acme Status" });
    await PUT(putRequest(submitted, { "If-Match": '"1784332800000"' }));
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<{ status: number; body: unknown } | null>;
    };

    // Reordered keys and a different updatedAt must still compare equal, as
    // long as the ETag itself is fresh against this retry's If-Match.
    const reordered = Object.fromEntries(Object.entries(submitted).reverse());
    vi.mocked(getStatusPageConfig).mockResolvedValue({
      data: { ...reordered, updatedAt: "2099-01-01T00:00:00.000Z" } as never,
      etag: '"1784332800000"',
    });
    await expect(options.recover({ operationId: "op-1" })).resolves.not.toBeNull();
  });

  it("recover still recognizes a semantically-equal-but-syntactically-different submitted body (finding: normalization drift check — the schema's only normalization, trim(), is idempotent and applied identically to both the originally-persisted document and this retry's reparse, so a body differing only in incidental whitespace must still compare equal)", async () => {
    // Extra leading/trailing whitespace in `name` that parseStatusPageConfigDocument's
    // trim() will normalize away — the stored document (itself normalized at
    // write time) never has this whitespace, so a byte-for-byte body compare
    // would spuriously diverge; the schema-level parse must not.
    const submitted = fullDocument({ name: "  Acme Status  " });
    await PUT(putRequest(submitted, { "If-Match": '"1784332800000"' }));
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<{ status: number; body: unknown } | null>;
    };

    vi.mocked(getStatusPageConfig).mockResolvedValue({
      data: { ...fullDocument({ name: "Acme Status" }), updatedAt: "2026-07-18T00:00:00.000Z" } as never,
      etag: '"1784332800000"',
    });
    await expect(options.recover({ operationId: "op-1" })).resolves.not.toBeNull();
  });

  it("recover returns null (rerun) when the submitted body no longer parses", async () => {
    const response = await PUT(putRequest({ name: "Acme Status" }, { "If-Match": '"1784332800000"' }));
    expect(response.status).toBe(200);
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<{ status: number; body: unknown } | null>;
    };
    await expect(options.recover({ operationId: "op-1" })).resolves.toBeNull();
  });

  it("maps a StatusPageConfigError inside work() itself, not thrown past executeIdempotent (finding: a thrown 412 left the idempotency record stuck 'running' until a stale reclaim's recover callback ran against a body that no longer parsed or a document that didn't match)", async () => {
    vi.mocked(putStatusPageConfig).mockRejectedValue(
      new StatusPageConfigError("PRECONDITION_FAILED", "changed since read"),
    );
    await PUT(putRequest({}, { "If-Match": '"9"' }));
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      work: (context: { operationId: string }) => Promise<{ status: number; body: unknown }>;
    };
    await expect(options.work({ operationId: "op-1" })).resolves.toEqual({
      status: 412,
      body: errorEnvelope("PRECONDITION_FAILED", "changed since read", "req_status_page", {}),
    });
  });
});
