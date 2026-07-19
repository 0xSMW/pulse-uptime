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
  promoteIncident: vi.fn(),
  recoverPromotedReport: vi.fn(),
}));

import { apiError, errorEnvelope, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, type ApiContext } from "@/lib/api/middleware";
import {
  promoteIncident,
  recoverPromotedReport,
  StatusReportError,
  type StatusReportData,
} from "@/lib/api/status-reports";

import { POST } from "./route";

const context: ApiContext = {
  principal: { type: "human", id: "usr-1", email: "admin@example.com", scopes: ["reports:write"] },
  principalKey: "human:usr-1",
  requestId: "req_promote",
};

const draft: StatusReportData = {
  id: "rep-1", type: "incident", title: "API outage",
  startsAt: "2026-07-18T09:00:00.000Z", endsAt: null,
  publishedAt: null, resolvedAt: null,
  originIncidentId: "inc-1", currentStatus: "investigating",
  updates: [{ id: "upd-1", status: "investigating", markdown: "Initial signal: HTTP 503.", publishedAt: "2026-07-18T09:00:00.000Z", createdAt: "2026-07-18T09:00:00.000Z" }],
  affected: [{ monitorId: "api-prod", monitorName: "API", groupName: "Core", impact: "down" }],
  createdAt: "2026-07-18T12:00:00.000Z", updatedAt: "2026-07-18T12:00:00.000Z",
};

const params = { params: Promise.resolve({ incidentId: "inc-1" }) };

function request() {
  return new Request("https://pulse.test/api/v1/incidents/inc-1/promote", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });
}

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context);
  vi.mocked(promoteIncident).mockReset().mockResolvedValue({ report: draft, created: true });
  vi.mocked(recoverPromotedReport).mockReset();
  vi.mocked(executeIdempotent).mockClear();
});

describe("POST /api/v1/incidents/{incidentId}/promote", () => {
  it("requires reports:write and returns 201 with the draft report envelope", async () => {
    const response = await POST(request(), params);
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), { scope: "reports:write" });
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.kind).toBe("StatusReport");
    expect(payload.data.publishedAt).toBeNull();
    expect(payload.data.originIncidentId).toBe("inc-1");
    expect(promoteIncident).toHaveBeenCalledWith("inc-1", { reportId: "op-1" });
  });

  it("returns 200 with the existing report when already promoted", async () => {
    vi.mocked(promoteIncident).mockResolvedValue({ report: draft, created: false });
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect((await response.json()).data.id).toBe("rep-1");
  });

  it("returns the authorization failure untouched", async () => {
    vi.mocked(authorize).mockResolvedValue(apiError("req_denied", 403, "SCOPE_DENIED", "denied"));
    const response = await POST(request(), params);
    expect(response.status).toBe(403);
    expect(promoteIncident).not.toHaveBeenCalled();
  });

  it("maps a missing incident to 404 INCIDENT_NOT_FOUND", async () => {
    vi.mocked(promoteIncident).mockRejectedValue(new StatusReportError("INCIDENT_NOT_FOUND", "missing"));
    const response = await POST(request(), params);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("INCIDENT_NOT_FOUND");
  });

  it("maps INCIDENT_NOT_FOUND inside work() itself, not thrown past executeIdempotent (finding: a thrown 404 left the idempotency record stuck 'running'; recover only ever recovers when a report already exists for this incident, so a genuinely unknown incident falls through to here every time)", async () => {
    vi.mocked(promoteIncident).mockRejectedValue(new StatusReportError("INCIDENT_NOT_FOUND", "missing"));
    await POST(request(), params);
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      work: (context: { operationId: string }) => Promise<{ status: number; body: unknown }>;
    };
    await expect(options.work({ operationId: "op-1" })).resolves.toEqual({
      status: 404,
      body: errorEnvelope("INCIDENT_NOT_FOUND", "missing", context.requestId, {}),
    });
  });

  it("wires a recover callback that replays a committed-then-crashed promote as success instead of re-validating the incident and re-serializing fresh values (finding: promote shipped with no recover callback)", async () => {
    await POST(request(), params);
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as {
      recover: (context: { operationId: string }) => Promise<{ status: number; body: unknown } | null>;
    };

    // Recovery hit, matching id: the recovered report's id equals THIS
    // retry's operationId — promoteIncident pinned the new report's id to
    // the operationId, so this exact crashed attempt is the one that
    // inserted it. Replays as 201, not 200 (finding: the recover callback
    // used to hard-code 200 here, misreporting a genuine creation as an
    // already-existing conflict).
    vi.mocked(recoverPromotedReport).mockResolvedValue({ ...draft, id: "op-1" });
    await expect(options.recover({ operationId: "op-1" })).resolves.toEqual({
      status: 201,
      body: objectEnvelope("StatusReport", { ...draft, id: "op-1" }, context.requestId),
    });
    expect(recoverPromotedReport).toHaveBeenCalledWith("inc-1");

    // Recovery hit, non-matching id: some other operation created the
    // report — a concurrent promote that won the originIncidentId race, or
    // one that already completed before this key was ever used. Replays as
    // 200, created:false semantics.
    vi.mocked(recoverPromotedReport).mockResolvedValue(draft);
    await expect(options.recover({ operationId: "op-1" })).resolves.toEqual({
      status: 200,
      body: objectEnvelope("StatusReport", draft, context.requestId),
    });

    // Recovery miss: no report exists yet for this incident (genuine crash
    // before the create committed) — fall through so work() reruns to
    // create it.
    vi.mocked(recoverPromotedReport).mockResolvedValue(null);
    await expect(options.recover({ operationId: "op-1" })).resolves.toBeNull();
  });

  it("refuses rather than reruns on a recovery miss", async () => {
    await POST(request(), params);
    const options = vi.mocked(executeIdempotent).mock.calls[0][0] as { rerunAfterRecoveryMiss?: boolean };
    expect(options.rerunAfterRecoveryMiss).toBe(false);
  });
});
