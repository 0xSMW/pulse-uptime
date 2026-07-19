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
  listStatusReportSummaries: vi.fn(),
  createStatusReport: vi.fn(),
}));

import { revalidatePath } from "next/cache";

import { apiError } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, type ApiContext } from "@/lib/api/middleware";
import {
  createStatusReport,
  listStatusReportSummaries,
  StatusReportError,
  type StatusReportData,
  type StatusReportListItemData,
} from "@/lib/api/status-reports";

import { GET, POST } from "./route";

const context: ApiContext = {
  principal: { type: "api_token", id: "tok-1", name: "agent", scopes: ["reports:read", "reports:write"], expiresAt: new Date() },
  principalKey: "api_token:tok-1",
  requestId: "req_reports",
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

// List rows are lean: update count + latest status/publishedAt, no markdown.
const listRow: StatusReportListItemData = {
  id: "rep-1", type: "incident", title: "API outage",
  startsAt: "2026-07-18T09:00:00.000Z", endsAt: null,
  publishedAt: "2026-07-18T09:05:00.000Z", resolvedAt: null,
  originIncidentId: null, currentStatus: "investigating",
  updatesCount: 1,
  latestUpdate: { status: "investigating", publishedAt: "2026-07-18T09:05:00.000Z" },
  affected: [{ monitorId: "api-prod", monitorName: "API", groupName: "Core", impact: "down" }],
  createdAt: "2026-07-18T09:05:00.000Z", updatedAt: "2026-07-18T09:05:00.000Z",
};

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context);
  vi.mocked(revalidatePath).mockReset();
  vi.mocked(listStatusReportSummaries).mockReset().mockResolvedValue({ data: [listRow], nextCursor: "cursor-2" });
  vi.mocked(createStatusReport).mockReset().mockResolvedValue(report);
  vi.mocked(executeIdempotent).mockClear();
});

describe("GET /api/v1/status-reports", () => {
  it("requires the reports:read scope", async () => {
    await GET(new Request("https://pulse.test/api/v1/status-reports"));
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), { scope: "reports:read" });
  });

  it("returns the authorization failure untouched", async () => {
    vi.mocked(authorize).mockResolvedValue(apiError("req_denied", 403, "SCOPE_DENIED", "denied"));
    const response = await GET(new Request("https://pulse.test/api/v1/status-reports"));
    expect(response.status).toBe(403);
    expect(listStatusReportSummaries).not.toHaveBeenCalled();
  });

  it("returns the lean list envelope with the cursor and threads filters", async () => {
    const response = await GET(new Request("https://pulse.test/api/v1/status-reports?state=draft&type=incident&limit=10"));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.kind).toBe("StatusReportList");
    expect(payload.apiVersion).toBe("v1");
    expect(payload.data).toEqual([listRow]);
    expect(JSON.stringify(payload.data)).not.toContain("markdown");
    expect(payload.meta).toEqual({ requestId: "req_reports", nextCursor: "cursor-2" });
    expect(listStatusReportSummaries).toHaveBeenCalledWith({ state: "draft", type: "incident", cursor: null, limit: 10 });
  });

  it("rejects invalid state filters and limits", async () => {
    const bad = await GET(new Request("https://pulse.test/api/v1/status-reports?state=open"));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("VALIDATION_ERROR");
    const limit = await GET(new Request("https://pulse.test/api/v1/status-reports?limit=0"));
    expect(limit.status).toBe(400);
    expect((await limit.json()).error.code).toBe("INVALID_LIMIT");
  });
});

describe("POST /api/v1/status-reports", () => {
  function postRequest(body: unknown) {
    return new Request("https://pulse.test/api/v1/status-reports", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
  }

  it("requires the reports:write scope and returns 201 with the report envelope", async () => {
    const response = await POST(postRequest({ type: "incident" }));
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), { scope: "reports:write" });
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.kind).toBe("StatusReport");
    expect(payload.data).toEqual(report);
  });

  it("revalidates the status page, permalink, and affected group pages", async () => {
    await POST(postRequest({ type: "incident" }));
    expect(revalidatePath).toHaveBeenCalledWith("/status");
    expect(revalidatePath).toHaveBeenCalledWith("/status/reports/rep-1");
    expect(revalidatePath).toHaveBeenCalledWith("/status/core");
  });

  it("pins the report id to the idempotency operationId and threads a tx-bound store into createStatusReport", async () => {
    await POST(postRequest({ type: "incident" }));
    expect(createStatusReport).toHaveBeenCalledWith(
      { type: "incident" },
      expect.objectContaining({ reportId: "op-1" }),
    );
  });

  it("maps validation failures to 400 VALIDATION_ERROR", async () => {
    vi.mocked(createStatusReport).mockRejectedValue(new StatusReportError("VALIDATION_ERROR", "Title is required"));
    const response = await POST(postRequest({}));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON bodies", async () => {
    const response = await POST(new Request("https://pulse.test/api/v1/status-reports", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: "{not json",
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_JSON");
  });

  it("maps VALIDATION_ERROR inside work() itself, not thrown past executeIdempotent (finding: a thrown error left the idempotency record stuck 'running' until a stale reclaim, which now simply reruns work() from scratch rather than trying to recover)", async () => {
    vi.mocked(createStatusReport).mockRejectedValue(new StatusReportError("VALIDATION_ERROR", "Title is required"));
    const response = await POST(postRequest({}));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  });
});
