import { beforeEach, describe, expect, it, vi } from "vitest";

const { idempotencyRecords } = vi.hoisted(() => ({
  idempotencyRecords: new Map<string, { status: number; body: unknown }>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}));
// Mimics executeIdempotent's real completion semantics well enough to test
// the route's error-storing behavior without touching lib/api/idempotency.ts:
// a completed key replays its stored response and never calls work() again,
// and a key only becomes "completed" if the transaction's run() resolves.
// If run() throws, nothing is recorded, which is what proves it rolled back.
vi.mock("@/lib/api/idempotency", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/idempotency")>()),
  executeIdempotent: vi.fn(async ({ request, work }: {
    request: Request;
    work: (context: {
      operationId: string;
      transaction: (run: (tx: unknown) => Promise<{ status: number; body: unknown }>) => Promise<{ status: number; body: unknown }>;
    }) => Promise<{ status: number; body: unknown }>;
  }) => {
    const key = request.headers.get("idempotency-key")!;
    const existing = idempotencyRecords.get(key);
    if (existing) return { ...existing, replayed: true };
    const result = await work({
      operationId: "op-1",
      transaction: async (run) => {
        const outcome = await run("tx");
        idempotencyRecords.set(key, outcome);
        return outcome;
      },
    });
    return { ...result, replayed: false };
  }),
}));
vi.mock("@/lib/api/monitors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/monitors")>()),
  setMonitorEnabled: vi.fn(),
}));

import { authorize, type ApiContext } from "@/lib/api/middleware";
import { MonitorApiError, setMonitorEnabled } from "@/lib/api/monitors";

import { POST } from "./route";

const context: ApiContext = {
  principal: { type: "cli_session", id: "cli-1", email: "admin@example.com", scopes: ["monitors:write"], expiresAt: new Date(), installation: { id: "ins-1", displayName: "Mac", platform: "darwin", architecture: "arm64", clientVersion: "1.0.0", linkedAt: new Date() } },
  principalKey: "cli_session:cli-1",
  requestId: "req_resume",
};

const monitor = {
  id: "site-home", name: "Site", url: "https://example.com", enabled: true, group: null, groupId: null,
  method: "GET" as const, intervalMinutes: 1 as const, timeoutMs: 8_000,
  expectedStatus: { minimum: 200, maximum: 399 }, failureThreshold: 2, recoveryThreshold: 2, recipients: [],
};
const params = { params: Promise.resolve({ monitorId: "site-home" }) };

function request(key = crypto.randomUUID()) {
  return new Request("https://pulse.test/api/v1/monitors/site-home/resume", {
    method: "POST",
    headers: { "Idempotency-Key": key },
  });
}

beforeEach(() => {
  idempotencyRecords.clear();
  vi.mocked(authorize).mockReset().mockResolvedValue(context);
  vi.mocked(setMonitorEnabled).mockReset();
});

describe("POST /api/v1/monitors/{monitorId}/resume", () => {
  it("resumes a monitor", async () => {
    vi.mocked(setMonitorEnabled).mockResolvedValue(monitor);
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect((await response.json()).data.enabled).toBe(true);
    expect(setMonitorEnabled).toHaveBeenCalledWith("site-home", true, context.principalKey, "tx");
  });

  it("stores a deterministic MONITOR_NOT_FOUND error as the operation's own completed response", async () => {
    vi.mocked(setMonitorEnabled).mockRejectedValue(new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found"));
    const key = crypto.randomUUID();
    const response = await POST(request(key), params);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("MONITOR_NOT_FOUND");
    expect(idempotencyRecords.get(key)?.status).toBe(404);
  });

  it("lets a transient CONFIGURATION_UNAVAILABLE error propagate, leaving no completed record", async () => {
    vi.mocked(setMonitorEnabled).mockRejectedValue(new MonitorApiError("CONFIGURATION_UNAVAILABLE", "Configuration store is unavailable"));
    const key = crypto.randomUUID();
    const response = await POST(request(key), params);
    expect(response.status).toBe(503);
    expect(idempotencyRecords.has(key)).toBe(false);
  });

  it("replays a stored MONITOR_NOT_FOUND response on retry without re-invoking setMonitorEnabled", async () => {
    vi.mocked(setMonitorEnabled).mockRejectedValue(new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found"));
    const key = crypto.randomUUID();
    const first = await POST(request(key), params);
    expect(first.status).toBe(404);
    expect(setMonitorEnabled).toHaveBeenCalledTimes(1);

    const second = await POST(request(key), params);
    expect(second.status).toBe(404);
    expect((await second.json()).error.code).toBe("MONITOR_NOT_FOUND");
    expect(setMonitorEnabled).toHaveBeenCalledTimes(1);
  });
});
