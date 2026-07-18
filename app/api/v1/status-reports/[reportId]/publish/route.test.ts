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
  publishStatusReport: vi.fn(),
  getStatusReport: vi.fn(),
}));

import { revalidatePath } from "next/cache";

import { objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, type ApiContext } from "@/lib/api/middleware";
import {
  getStatusReport,
  publishStatusReport,
  StatusReportError,
  type StatusReportData,
} from "@/lib/api/status-reports";

import { POST } from "./route";

const context: ApiContext = {
  principal: { type: "cli_session", id: "cli-1", email: "admin@example.com", scopes: ["reports:write"], expiresAt: new Date(), installation: { id: "ins-1", displayName: "Mac", platform: "darwin", architecture: "arm64", clientVersion: "1.0.0", linkedAt: new Date() } },
  principalKey: "cli_session:cli-1",
  requestId: "req_publish",
};

const report: StatusReportData = {
  id: "rep-1", type: "incident", title: "API outage",
  startsAt: "2026-07-18T09:00:00.000Z", endsAt: null,
  publishedAt: "2026-07-18T12:00:00.000Z", resolvedAt: null,
  originIncidentId: null, currentStatus: "investigating",
  updates: [{ id: "upd-1", status: "investigating", markdown: "Looking.", publishedAt: "2026-07-18T09:05:00.000Z", createdAt: "2026-07-18T09:05:00.000Z" }],
  affected: [],
  createdAt: "2026-07-18T09:05:00.000Z", updatedAt: "2026-07-18T12:00:00.000Z",
};

function request() {
  return new Request("https://pulse.test/api/v1/status-reports/rep-1/publish", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });
}

const params = { params: Promise.resolve({ reportId: "rep-1" }) };

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context);
  vi.mocked(revalidatePath).mockReset();
  vi.mocked(publishStatusReport).mockReset().mockResolvedValue(report);
  vi.mocked(getStatusReport).mockReset();
  vi.mocked(executeIdempotent).mockClear();
});

describe("POST /api/v1/status-reports/{reportId}/publish", () => {
  it("requires reports:write, publishes, and revalidates the public pages", async () => {
    const response = await POST(request(), params);
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), { scope: "reports:write" });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.kind).toBe("StatusReport");
    expect(payload.data.publishedAt).toBe("2026-07-18T12:00:00.000Z");
    expect(publishStatusReport).toHaveBeenCalledWith("rep-1");
    expect(revalidatePath).toHaveBeenCalledWith("/status");
    expect(revalidatePath).toHaveBeenCalledWith("/status/reports/rep-1");
  });

  it("maps a second publish to 409 ALREADY_PUBLISHED", async () => {
    vi.mocked(publishStatusReport).mockRejectedValue(new StatusReportError("ALREADY_PUBLISHED", "already"));
    const response = await POST(request(), params);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("ALREADY_PUBLISHED");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("maps a missing report to 404", async () => {
    vi.mocked(publishStatusReport).mockRejectedValue(new StatusReportError("REPORT_NOT_FOUND", "missing"));
    const response = await POST(request(), params);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("REPORT_NOT_FOUND");
  });

  it("wires a recover callback that returns the already-published report instead of rerunning into ALREADY_PUBLISHED (finding: publish retries 409 after a crash)", async () => {
    await POST(request(), params);
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<{ status: number; body: unknown } | null>;
    };

    // Recovery hit: a prior attempt already committed the publish before
    // crashing — the retry must surface that success, not ALREADY_PUBLISHED.
    vi.mocked(getStatusReport).mockResolvedValue(report);
    await expect(options.recover({ operationId: "op-1" })).resolves.toEqual({
      status: 200,
      body: objectEnvelope("StatusReport", report, context.requestId),
    });

    // Recovery miss: the report exists but isn't published yet (the crash hit
    // before the publish committed) — fall through so work() actually
    // publishes it, rather than treating it as already recovered.
    vi.mocked(getStatusReport).mockResolvedValue({ ...report, publishedAt: null });
    await expect(options.recover({ operationId: "op-1" })).resolves.toBeNull();

    // Recovery miss: the report is gone entirely — also falls through, and
    // work() will surface REPORT_NOT_FOUND as usual.
    vi.mocked(getStatusReport).mockRejectedValue(new StatusReportError("REPORT_NOT_FOUND", "missing"));
    await expect(options.recover({ operationId: "op-1" })).resolves.toBeNull();
  });
});
