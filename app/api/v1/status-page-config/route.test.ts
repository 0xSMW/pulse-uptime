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

const data = { name: "Acme Status", historyDays: 90, updatedAt: "2026-07-18T00:00:00.000Z", version: 5 };
// Distinct post-write version so the ETag the route derives from it (via
// etagFor, which reads data.version, not data.updatedAt) differs from the
// pre-write ETag above.
const updatedData = { name: "Acme Status", historyDays: 90, updatedAt: "2026-07-18T00:18:20.000Z", version: 6 };

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

    // work() and recover() must still see the RAW body/If-Match, unaffected
    // by the composite fingerprint value.
    expect(putStatusPageConfig).toHaveBeenCalledWith({ name: "Acme Status" }, '"6"');
  });

  it("threads the body and If-Match into the service and returns the ETag derived from the new version", async () => {
    const response = await PUT(putRequest({ name: "Acme Status" }, { "If-Match": '"5"' }));
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe('"6"');
    expect(putStatusPageConfig).toHaveBeenCalledWith({ name: "Acme Status" }, '"5"');
    const payload = await response.json();
    expect(payload.kind).toBe("StatusPageConfig");
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

  it("wires a recover callback that replays a committed-then-crashed write as 200 with the ADVANCED ETag, even though this retry's own If-Match still carries the PRE-write value (finding: the guarded write bumps the monotonic version/ETag on every success, so a prior pass requiring If-Match == current in recover made a normal committed-then-crashed retry — whose If-Match is necessarily the OLD value — always miss recovery, rerun, and 412 against its own write)", async () => {
    const submitted = fullDocument({ name: "Acme Status" });
    await PUT(putRequest(submitted, { "If-Match": '"5"' }));
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<{ status: number; body: unknown } | null>;
    };

    // Recovery hit: the CURRENT document (version bumped to 6 by the
    // committed write) already deep-equals what was submitted, even though
    // this retry's own If-Match ("5") is now stale against the current ETag
    // ("6"); a prior attempt committed the write before crashing, so the
    // retry recovers with the current state (and its advanced ETag) instead
    // of rerunning putStatusPageConfig and 412ing against its own write.
    const recoveredData = { ...submitted, updatedAt: "2026-07-18T00:18:20.000Z", version: 6 };
    vi.mocked(getStatusPageConfig).mockResolvedValue({ data: recoveredData as never, etag: '"6"' });
    await expect(options.recover({ operationId: "op-1" })).resolves.toEqual({ status: 200, body: recoveredData });

    // Recovery miss: the current document genuinely differs (the crash hit
    // before the write committed, or something else changed it since); fall
    // through so work() reruns the real If-Match-guarded write.
    vi.mocked(getStatusPageConfig).mockResolvedValue({
      data: { ...submitted, name: "Something Else", updatedAt: "2026-07-18T00:00:00.000Z", version: 5 } as never,
      etag: '"5"',
    });
    await expect(options.recover({ operationId: "op-1" })).resolves.toBeNull();
  });

  it("recover refuses a document match whose version could not have been produced by THIS retry's If-Match (finding: a stale-If-Match's document merely happening to equal the current document — e.g. another writer advancing the version further, or converging on the same edit from a different base — must not be treated as this retry's own recovered success)", async () => {
    const submitted = fullDocument({ name: "Acme Status" });
    await PUT(putRequest(submitted, { "If-Match": '"5"' }));
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<{ status: number; body: unknown } | null>;
    };

    // The document deep-equals what was submitted, but the current version
    // (7) is not exactly this retry's If-Match (5) + 1: a write guarded by
    // If-Match="5" could only ever have produced version 6, so version 7
    // proves some OTHER write (or writes) landed after the one this retry
    // could have made. Recovery must be refused even though the body matches.
    const recoveredData = { ...submitted, updatedAt: "2026-07-18T00:18:20.000Z", version: 7 };
    vi.mocked(getStatusPageConfig).mockResolvedValue({ data: recoveredData as never, etag: '"7"' });
    await expect(options.recover({ operationId: "op-1" })).resolves.toBeNull();
  });

  it("recover refuses when this retry's own If-Match is not a clean quoted integer (finding: a malformed/weak If-Match can't be proven to have been satisfiable, so it must not manufacture a 200)", async () => {
    const submitted = fullDocument({ name: "Acme Status" });
    await PUT(putRequest(submitted, { "If-Match": 'W/"5"' }));
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<{ status: number; body: unknown } | null>;
    };

    const recoveredData = { ...submitted, updatedAt: "2026-07-18T00:18:20.000Z", version: 6 };
    vi.mocked(getStatusPageConfig).mockResolvedValue({ data: recoveredData as never, etag: '"6"' });
    await expect(options.recover({ operationId: "op-1" })).resolves.toBeNull();
  });

  it("recover ignores field order, the read-only updatedAt, and the read-only version when comparing documents", async () => {
    const submitted = fullDocument({ name: "Acme Status" });
    await PUT(putRequest(submitted, { "If-Match": '"5"' }));
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<{ status: number; body: unknown } | null>;
    };

    // Reordered keys, a different updatedAt, and an advanced version must
    // still compare equal: those are exactly the fields a committed write
    // changes, and none of them was part of what the caller submitted.
    const reordered = Object.fromEntries(Object.entries(submitted).reverse());
    vi.mocked(getStatusPageConfig).mockResolvedValue({
      data: { ...reordered, updatedAt: "2099-01-01T00:00:00.000Z", version: 6 } as never,
      etag: '"6"',
    });
    await expect(options.recover({ operationId: "op-1" })).resolves.not.toBeNull();
  });

  it("recover still recognizes a semantically-equal-but-syntactically-different submitted body (finding: normalization drift check — the schema's only normalization, trim(), is idempotent and applied identically to both the originally-persisted document and this retry's reparse, so a body differing only in incidental whitespace must still compare equal)", async () => {
    // Extra leading/trailing whitespace in `name` that parseStatusPageConfigDocument's
    // trim() will normalize away; the stored document (itself normalized at
    // write time) never has this whitespace, so a byte-for-byte body compare
    // would spuriously diverge; the schema-level parse must not.
    const submitted = fullDocument({ name: "  Acme Status  " });
    await PUT(putRequest(submitted, { "If-Match": '"5"' }));
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<{ status: number; body: unknown } | null>;
    };

    vi.mocked(getStatusPageConfig).mockResolvedValue({
      data: { ...fullDocument({ name: "Acme Status" }), updatedAt: "2026-07-18T00:00:00.000Z", version: 6 } as never,
      etag: '"6"',
    });
    await expect(options.recover({ operationId: "op-1" })).resolves.not.toBeNull();
  });

  it("a genuinely stale If-Match with a genuinely DIFFERENT body still 412s on the first attempt via work(), not a manufactured recover success (finding: dropping the If-Match-freshness check from recover only ever lets an EQUAL-body retry through — a real conflict still reaches work()'s conditional UPDATE, which records the 412 rather than throwing past executeIdempotent)", async () => {
    vi.mocked(putStatusPageConfig).mockRejectedValue(
      new StatusPageConfigError("PRECONDITION_FAILED", "changed since read"),
    );
    const response = await PUT(putRequest(fullDocument({ name: "Someone Else's Edit" }), { "If-Match": '"5"' }));
    expect(response.status).toBe(412);
    expect((await response.json()).error.code).toBe("PRECONDITION_FAILED");
  });

  it("recover returns null (rerun) when the submitted body no longer parses", async () => {
    const response = await PUT(putRequest({ name: "Acme Status" }, { "If-Match": '"5"' }));
    expect(response.status).toBe(200);
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<{ status: number; body: unknown } | null>;
    };
    await expect(options.recover({ operationId: "op-1" })).resolves.toBeNull();
  });

  it("refuses rather than reruns on a recovery miss (finding: rerunAfterRecoveryMiss defaulting to rerun would let a stale retry re-run putStatusPageConfig against whatever the caller submitted instead of surfacing 'cannot recover safely, retry with a new key')", async () => {
    await PUT(putRequest({ name: "Acme Status" }, { "If-Match": '"5"' }));
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as { rerunAfterRecoveryMiss?: boolean };
    expect(options.rerunAfterRecoveryMiss).toBe(false);
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
