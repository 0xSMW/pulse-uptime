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
vi.mock("@/lib/api/status-reports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/status-reports")>()),
  editReportUpdate: vi.fn(),
  deleteReportUpdate: vi.fn(),
  recoverEditedReportUpdate: vi.fn(),
}));

import { revalidatePath } from "next/cache";

import { errorEnvelope, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, type ApiContext } from "@/lib/api/middleware";
import {
  deleteReportUpdate,
  editReportUpdate,
  recoverEditedReportUpdate,
  StatusReportError,
  type StatusReportData,
} from "@/lib/api/status-reports";

import { DELETE, PATCH } from "./route";

const context: ApiContext = {
  principal: { type: "human", id: "usr-1", email: "admin@example.com", scopes: ["reports:write"] },
  principalKey: "human:usr-1",
  requestId: "req_edit",
};

const report: StatusReportData = {
  id: "rep-1", type: "incident", title: "API outage",
  startsAt: "2026-07-18T09:00:00.000Z", endsAt: null,
  publishedAt: "2026-07-18T09:05:00.000Z", resolvedAt: null,
  originIncidentId: null, currentStatus: "monitoring",
  updates: [{ id: "upd-1", status: "monitoring", markdown: "Watching.", publishedAt: "2026-07-18T10:00:00.000Z", createdAt: "2026-07-18T10:00:00.000Z" }],
  affected: [],
  createdAt: "2026-07-18T09:05:00.000Z", updatedAt: "2026-07-18T10:00:00.000Z",
};

const params = { params: Promise.resolve({ reportId: "rep-1", updateId: "upd-1" }) };

function request(method: string, body?: unknown) {
  return new Request("https://pulse.test/api/v1/status-reports/rep-1/updates/upd-1", {
    method,
    headers: { "Idempotency-Key": crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context);
  vi.mocked(revalidatePath).mockReset();
  vi.mocked(editReportUpdate).mockReset().mockResolvedValue(report);
  vi.mocked(deleteReportUpdate).mockReset().mockResolvedValue(report);
  vi.mocked(recoverEditedReportUpdate).mockReset();
  vi.mocked(executeIdempotent).mockClear();
});

describe("PATCH /api/v1/status-reports/{reportId}/updates/{updateId}", () => {
  it("requires reports:write, sends only changed keys through, and revalidates", async () => {
    const response = await PATCH(request("PATCH", { publishedAt: "2026-07-18T08:00:00.000Z" }), params);
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), { scope: "reports:write" });
    expect(response.status).toBe(200);
    expect(editReportUpdate).toHaveBeenCalledWith("rep-1", "upd-1", { publishedAt: "2026-07-18T08:00:00.000Z" });
    expect((await response.json()).kind).toBe("StatusReport");
    expect(revalidatePath).toHaveBeenCalledWith("/status");
  });

  it("maps a missing update to 404 UPDATE_NOT_FOUND", async () => {
    vi.mocked(editReportUpdate).mockRejectedValue(new StatusReportError("UPDATE_NOT_FOUND", "missing"));
    const response = await PATCH(request("PATCH", { status: "monitoring" }), params);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("UPDATE_NOT_FOUND");
  });

  it("wires a recover callback that returns the current state instead of rerunning the edit (finding: PATCH /updates/{updateId} was the only mutation in this family shipped without one)", async () => {
    const body = { status: "monitoring" };
    await PATCH(request("PATCH", body), params);
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<{ status: number; body: unknown } | null>;
    };

    // Recovery hit: a prior attempt already committed the edit before
    // crashing — the retry must surface that state as success instead of
    // rerunning editReportUpdate (and its resolution recompute) again.
    vi.mocked(recoverEditedReportUpdate).mockResolvedValue(report);
    await expect(options.recover({ operationId: "op-1" })).resolves.toEqual({
      status: 200,
      body: objectEnvelope("StatusReport", report, context.requestId),
    });
    expect(recoverEditedReportUpdate).toHaveBeenCalledWith("rep-1", "upd-1", body);

    // Recovery miss: the current state genuinely differs (crash before the
    // edit committed) — fall through so work() actually applies it.
    vi.mocked(recoverEditedReportUpdate).mockResolvedValue(null);
    await expect(options.recover({ operationId: "op-1" })).resolves.toBeNull();
  });
});

describe("DELETE /api/v1/status-reports/{reportId}/updates/{updateId}", () => {
  it("deletes and returns the refreshed report", async () => {
    const response = await DELETE(request("DELETE"), params);
    expect(response.status).toBe(200);
    expect(deleteReportUpdate).toHaveBeenCalledWith("rep-1", "upd-1");
    expect((await response.json()).kind).toBe("StatusReport");
    expect(revalidatePath).toHaveBeenCalledWith("/status/reports/rep-1");
  });

  it("maps the last-update guard to 409 LAST_UPDATE", async () => {
    vi.mocked(deleteReportUpdate).mockRejectedValue(new StatusReportError("LAST_UPDATE", "keep one"));
    const response = await DELETE(request("DELETE"), params);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("LAST_UPDATE");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("maps a missing update to 404 UPDATE_NOT_FOUND", async () => {
    vi.mocked(deleteReportUpdate).mockRejectedValue(new StatusReportError("UPDATE_NOT_FOUND", "missing"));
    const response = await DELETE(request("DELETE"), params);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("UPDATE_NOT_FOUND");
  });

  it("maps UPDATE_NOT_FOUND inside work() itself, with no recover callback (finding: a thrown 404 left the idempotency record stuck 'running' until a stale reclaim's recover manufactured a false success from the same 'update is gone' state a genuine 404 would also produce)", async () => {
    vi.mocked(deleteReportUpdate).mockRejectedValue(new StatusReportError("UPDATE_NOT_FOUND", "missing"));
    await DELETE(request("DELETE"), params);
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover?: unknown;
      work: (context: { operationId: string }) => Promise<{ status: number; body: unknown }>;
    };
    expect(options.recover).toBeUndefined();
    await expect(options.work({ operationId: "op-1" })).resolves.toEqual({
      status: 404,
      body: errorEnvelope("UPDATE_NOT_FOUND", "missing", context.requestId, {}),
    });
  });
});
