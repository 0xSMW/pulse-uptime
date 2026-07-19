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
  getStatusReport: vi.fn(),
  updateStatusReport: vi.fn(),
  deleteStatusReport: vi.fn(),
  recoverDeletedStatusReport: vi.fn(),
}));

import { revalidatePath } from "next/cache";

import { errorEnvelope, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, type ApiContext } from "@/lib/api/middleware";
import {
  deleteStatusReport,
  getStatusReport,
  recoverDeletedStatusReport,
  StatusReportError,
  updateStatusReport,
  type StatusReportData,
} from "@/lib/api/status-reports";

import { DELETE, GET, PATCH } from "./route";

const context: ApiContext = {
  principal: { type: "human", id: "usr-1", email: "admin@example.com", scopes: ["reports:read", "reports:write"] },
  principalKey: "human:usr-1",
  requestId: "req_report",
};

const report: StatusReportData = {
  id: "rep-1", type: "incident", title: "API outage",
  startsAt: "2026-07-18T09:00:00.000Z", endsAt: null,
  publishedAt: "2026-07-18T09:05:00.000Z", resolvedAt: null,
  originIncidentId: null, currentStatus: "investigating",
  updates: [{ id: "upd-1", status: "investigating", markdown: "Looking into it.", publishedAt: "2026-07-18T09:05:00.000Z", createdAt: "2026-07-18T09:05:00.000Z" }],
  affected: [{ monitorId: "api-prod", monitorName: "API", groupName: "Core", impact: "down" }],
  createdAt: "2026-07-18T09:05:00.000Z", updatedAt: "2026-07-18T09:05:00.000Z",
};

const params = { params: Promise.resolve({ reportId: "rep-1" }) };

function request(method: string, body?: unknown) {
  return new Request("https://pulse.test/api/v1/status-reports/rep-1", {
    method,
    headers: { "Idempotency-Key": crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context);
  vi.mocked(revalidatePath).mockReset();
  vi.mocked(getStatusReport).mockReset().mockResolvedValue(report);
  vi.mocked(updateStatusReport).mockReset().mockResolvedValue(report);
  vi.mocked(deleteStatusReport).mockReset().mockResolvedValue({ id: "rep-1" });
  vi.mocked(recoverDeletedStatusReport).mockReset();
  vi.mocked(executeIdempotent).mockClear();
});

describe("GET /api/v1/status-reports/{reportId}", () => {
  it("requires reports:read and returns the report envelope", async () => {
    const response = await GET(request("GET"), params);
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), { scope: "reports:read" });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.kind).toBe("StatusReport");
    expect(payload.data).toEqual(report);
  });

  it("maps REPORT_NOT_FOUND to 404", async () => {
    vi.mocked(getStatusReport).mockRejectedValue(new StatusReportError("REPORT_NOT_FOUND", "missing"));
    const response = await GET(request("GET"), params);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("REPORT_NOT_FOUND");
  });
});

describe("PATCH /api/v1/status-reports/{reportId}", () => {
  it("requires reports:write, applies the patch, and revalidates", async () => {
    const response = await PATCH(request("PATCH", { title: "New title" }), params);
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), { scope: "reports:write" });
    expect(response.status).toBe(200);
    expect(updateStatusReport).toHaveBeenCalledWith("rep-1", { title: "New title" });
    expect(revalidatePath).toHaveBeenCalledWith("/status");
    expect(revalidatePath).toHaveBeenCalledWith("/status/reports/rep-1");
    expect(revalidatePath).toHaveBeenCalledWith("/status/core");
  });

  it("maps validation failures to 400", async () => {
    vi.mocked(updateStatusReport).mockRejectedValue(new StatusReportError("VALIDATION_ERROR", "empty patch"));
    const response = await PATCH(request("PATCH", {}), params);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("revalidates both the pre-patch and post-patch group pages when affected is replaced", async () => {
    vi.mocked(getStatusReport).mockResolvedValue({
      ...report,
      affected: [{ monitorId: "db-prod", monitorName: "Database", groupName: "Data", impact: "down" }],
    });
    const response = await PATCH(request("PATCH", { affected: [{ monitorId: "api-prod", impact: "down" }] }), params);
    expect(response.status).toBe(200);
    // Post-patch group (from the mutation result) and pre-patch group (from
    // the pre-image) both refresh so the report never lingers on a page it left.
    expect(revalidatePath).toHaveBeenCalledWith("/status/core");
    expect(revalidatePath).toHaveBeenCalledWith("/status/data");
  });

  it("wires a recover callback that returns the current state instead of re-snapshotting on replay (finding: PATCH retries re-snapshot renamed/moved monitors)", async () => {
    await PATCH(request("PATCH", { title: "New title" }), params);
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<{ status: number; body: unknown } | null>;
    };

    // Recovery hit: the current report's title already matches the patch:
    // a prior attempt committed it before crashing, so the retry must
    // return that state as success instead of calling updateStatusReport
    // (and re-snapshotting affected) again.
    vi.mocked(getStatusReport).mockResolvedValue({ ...report, title: "New title" });
    await expect(options.recover({ operationId: "op-1" })).resolves.toEqual({
      status: 200,
      body: objectEnvelope("StatusReport", { ...report, title: "New title" }, context.requestId),
    });

    // Recovery miss: the current title still differs from the requested
    // patch: the crash hit before the patch committed, so fall through
    // and let work() actually apply it.
    vi.mocked(getStatusReport).mockResolvedValue(report);
    await expect(options.recover({ operationId: "op-1" })).resolves.toBeNull();

    // Recovery miss: an unknown report (never existed / already deleted)
    // must also rerun rather than recover.
    vi.mocked(getStatusReport).mockRejectedValue(new StatusReportError("REPORT_NOT_FOUND", "missing"));
    await expect(options.recover({ operationId: "op-1" })).resolves.toBeNull();
  });

  it("maps VALIDATION_ERROR / REPORT_NOT_FOUND inside work() itself (finding: a thrown error left the idempotency record stuck 'running' until a stale reclaim's recover callback fell through to true for an invalid patch body and replayed a false 200 instead of the genuine 400)", async () => {
    vi.mocked(updateStatusReport).mockRejectedValue(new StatusReportError("VALIDATION_ERROR", "Provide at least one field to update"));
    await PATCH(request("PATCH", {}), params);
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      work: (context: { operationId: string }) => Promise<{ status: number; body: unknown }>;
    };
    await expect(options.work({ operationId: "op-1" })).resolves.toEqual({
      status: 400,
      body: errorEnvelope("VALIDATION_ERROR", "Provide at least one field to update", context.requestId, {}),
    });
  });

  it("revalidates ISR pages on a recovered replay too (finding: a crash between the mutation committing and revalidation running left ISR pages stale until the 30s refresh, since the recover path returned without ever calling revalidateStatusReportPaths)", async () => {
    await PATCH(request("PATCH", { title: "New title" }), params);
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<{ status: number; body: unknown } | null>;
    };

    vi.mocked(revalidatePath).mockClear();
    vi.mocked(getStatusReport).mockResolvedValue({ ...report, title: "New title" });
    await options.recover({ operationId: "op-1" });
    expect(revalidatePath).toHaveBeenCalledWith("/status");
    expect(revalidatePath).toHaveBeenCalledWith("/status/reports/rep-1");
    expect(revalidatePath).toHaveBeenCalledWith("/status/core");
  });

  it("recover compares affected as an order-independent set and rejects a genuinely different set", async () => {
    await PATCH(request("PATCH", { affected: [{ monitorId: "api-prod", impact: "down" }] }), params);
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<{ status: number; body: unknown } | null>;
    };

    vi.mocked(getStatusReport).mockResolvedValue({
      ...report,
      affected: [{ monitorId: "api-prod", monitorName: "API", groupName: "Core", impact: "down" }],
    });
    await expect(options.recover({ operationId: "op-1" })).resolves.toEqual({
      status: 200,
      body: objectEnvelope("StatusReport", {
        ...report,
        affected: [{ monitorId: "api-prod", monitorName: "API", groupName: "Core", impact: "down" }],
      }, context.requestId),
    });

    vi.mocked(getStatusReport).mockResolvedValue({
      ...report,
      affected: [{ monitorId: "db-prod", monitorName: "Database", groupName: "Data", impact: "down" }],
    });
    await expect(options.recover({ operationId: "op-1" })).resolves.toBeNull();
  });

  it("refuses rather than reruns on a recovery miss (finding: rerunAfterRecoveryMiss defaulting to rerun let a stale retry re-apply this patch on top of a DIFFERENT edit made since, clobbering it; refusing surfaces 'cannot recover safely, retry with a new key' instead)", async () => {
    await PATCH(request("PATCH", { title: "New title" }), params);
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as { rerunAfterRecoveryMiss?: boolean };
    expect(options.rerunAfterRecoveryMiss).toBe(false);
  });
});

describe("DELETE /api/v1/status-reports/{reportId}", () => {
  it("deletes, revalidates, and returns a 200 deletion envelope", async () => {
    const response = await DELETE(request("DELETE"), params);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.kind).toBe("StatusReportDeleted");
    expect(payload.data).toEqual({ id: "rep-1" });
    expect(deleteStatusReport).toHaveBeenCalledWith("rep-1");
    expect(revalidatePath).toHaveBeenCalledWith("/status");
  });

  it("maps a missing report to 404", async () => {
    vi.mocked(getStatusReport).mockRejectedValue(new StatusReportError("REPORT_NOT_FOUND", "missing"));
    const response = await DELETE(request("DELETE"), params);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("REPORT_NOT_FOUND");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("maps REPORT_NOT_FOUND inside work() itself (finding: a thrown 404 left the idempotency record stuck 'running' until a stale reclaim's recover callback saw the exact 'report is gone' state a genuine 404 would also produce, and replayed it as a false 200)", async () => {
    vi.mocked(getStatusReport).mockRejectedValue(new StatusReportError("REPORT_NOT_FOUND", "missing"));
    await DELETE(request("DELETE"), params);
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      work: (context: { operationId: string }) => Promise<{ status: number; body: unknown }>;
    };
    await expect(options.work({ operationId: "op-1" })).resolves.toEqual({
      status: 404,
      body: errorEnvelope("REPORT_NOT_FOUND", "missing", context.requestId, {}),
    });
  });

  it("wires a recover callback that replays a committed-then-crashed delete as success instead of rerunning into a false REPORT_NOT_FOUND 404 (finding: DELETE shipped with no recover callback)", async () => {
    await DELETE(request("DELETE"), params);
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<{ status: number; body: unknown } | null>;
    };

    vi.mocked(recoverDeletedStatusReport).mockResolvedValue(true);
    await expect(options.recover({ operationId: "op-1" })).resolves.toEqual({
      status: 200,
      body: objectEnvelope("StatusReportDeleted", { id: "rep-1" }, context.requestId),
    });
    expect(recoverDeletedStatusReport).toHaveBeenCalledWith("rep-1");

    // Recovery miss: the report still exists: a genuine crash before the
    // delete committed, so fall through so work() reruns the real delete.
    vi.mocked(recoverDeletedStatusReport).mockResolvedValue(false);
    await expect(options.recover({ operationId: "op-1" })).resolves.toBeNull();
  });

  it("revalidates on a recovered replay too, via the blanket whole-surface path (finding: a crash between the delete committing and revalidation running left ISR pages stale; the deleted report leaves no report object to derive group slugs from, so this falls back to the same blanket revalidatePath('/status', 'layout') the config PUT route uses for exactly this case)", async () => {
    await DELETE(request("DELETE"), params);
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<{ status: number; body: unknown } | null>;
    };

    vi.mocked(revalidatePath).mockClear();
    vi.mocked(recoverDeletedStatusReport).mockResolvedValue(true);
    await options.recover({ operationId: "op-1" });
    expect(revalidatePath).toHaveBeenCalledWith("/status", "layout");

    vi.mocked(revalidatePath).mockClear();
    vi.mocked(recoverDeletedStatusReport).mockResolvedValue(false);
    await options.recover({ operationId: "op-1" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses rather than reruns on a recovery miss", async () => {
    await DELETE(request("DELETE"), params);
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as { rerunAfterRecoveryMiss?: boolean };
    expect(options.rerunAfterRecoveryMiss).toBe(false);
  });
});
