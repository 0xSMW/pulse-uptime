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
    work: (context: { operationId: string; transaction: (run: (tx: unknown) => Promise<unknown>) => Promise<unknown> }) => Promise<{ status: number; body: unknown }>;
  }) => ({
    ...(await work({ operationId: "op-1", transaction: (run) => run("tx") })),
    replayed: false,
  })),
}));
vi.mock("@/lib/api/status-reports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/status-reports")>()),
  addReportUpdate: vi.fn(),
}));

import { revalidatePath } from "next/cache";

import { apiError } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, type ApiContext } from "@/lib/api/middleware";
import {
  addReportUpdate,
  StatusReportError,
  type StatusReportData,
} from "@/lib/api/status-reports";

import { POST } from "./route";

const context: ApiContext = {
  principal: { type: "human", id: "usr-1", email: "admin@example.com", scopes: ["reports:write"] },
  principalKey: "human:usr-1",
  requestId: "req_update",
};

const report: StatusReportData = {
  id: "rep-1", type: "incident", title: "API outage",
  startsAt: "2026-07-18T09:00:00.000Z", endsAt: null,
  publishedAt: "2026-07-18T09:05:00.000Z", resolvedAt: "2026-07-18T13:00:00.000Z",
  originIncidentId: null, currentStatus: "resolved",
  updates: [
    { id: "upd-2", status: "resolved", markdown: "Fixed.", publishedAt: "2026-07-18T13:00:00.000Z", createdAt: "2026-07-18T13:00:00.000Z" },
    { id: "upd-1", status: "investigating", markdown: "Looking.", publishedAt: "2026-07-18T09:05:00.000Z", createdAt: "2026-07-18T09:05:00.000Z" },
  ],
  affected: [{ monitorId: "api-prod", monitorName: "API", groupName: "Core", impact: "down" }],
  createdAt: "2026-07-18T09:05:00.000Z", updatedAt: "2026-07-18T13:00:00.000Z",
};

const params = { params: Promise.resolve({ reportId: "rep-1" }) };

function request(body: unknown) {
  return new Request("https://pulse.test/api/v1/status-reports/rep-1/updates", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context);
  vi.mocked(revalidatePath).mockReset();
  vi.mocked(addReportUpdate).mockReset().mockResolvedValue(report);
  vi.mocked(executeIdempotent).mockClear();
});

describe("POST /api/v1/status-reports/{reportId}/updates", () => {
  it("requires reports:write and returns 201 with the refreshed report", async () => {
    const response = await POST(request({ status: "resolved", markdown: "Fixed." }), params);
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), { scope: "reports:write" });
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.kind).toBe("StatusReport");
    expect(payload.data.currentStatus).toBe("resolved");
    // The update id is pinned to the idempotency operationId, so a stale
    // reclaim's rerun of work() always names the same update row.
    expect(addReportUpdate).toHaveBeenCalledWith(
      "rep-1",
      { status: "resolved", markdown: "Fixed." },
      expect.objectContaining({ updateId: "op-1" }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/status");
    expect(revalidatePath).toHaveBeenCalledWith("/status/reports/rep-1");
    expect(revalidatePath).toHaveBeenCalledWith("/status/core");
  });

  it("returns the authorization failure untouched", async () => {
    vi.mocked(authorize).mockResolvedValue(apiError("req_denied", 403, "SCOPE_DENIED", "denied"));
    const response = await POST(request({ status: "resolved", markdown: "Fixed." }), params);
    expect(response.status).toBe(403);
    expect(addReportUpdate).not.toHaveBeenCalled();
  });

  it("maps a missing report to 404", async () => {
    vi.mocked(addReportUpdate).mockRejectedValue(new StatusReportError("REPORT_NOT_FOUND", "missing"));
    const response = await POST(request({ status: "resolved", markdown: "Fixed." }), params);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("REPORT_NOT_FOUND");
  });

  it("maps REPORT_NOT_FOUND inside work() itself, not thrown past executeIdempotent (finding: a thrown error left the idempotency record stuck 'running' until a stale reclaim, which now simply reruns work() from scratch rather than trying to recover)", async () => {
    vi.mocked(addReportUpdate).mockRejectedValue(new StatusReportError("REPORT_NOT_FOUND", "missing"));
    const response = await POST(request({ status: "resolved", markdown: "Fixed." }), params);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("REPORT_NOT_FOUND");
  });
});
