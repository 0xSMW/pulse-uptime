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
// the routes' error-storing behavior without touching lib/api/idempotency.ts:
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
  createMonitor: vi.fn(),
  listMonitors: vi.fn(),
}));

import { authorize, type ApiContext } from "@/lib/api/middleware";
import { createMonitor, MonitorApiError } from "@/lib/api/monitors";

import { POST } from "./route";

const context: ApiContext = {
  principal: { type: "cli_session", id: "cli-1", email: "admin@example.com", scopes: ["monitors:write"], expiresAt: new Date(), installation: { id: "ins-1", displayName: "Mac", platform: "darwin", architecture: "arm64", clientVersion: "1.0.0", linkedAt: new Date() } },
  principalKey: "cli_session:cli-1",
  requestId: "req_monitors",
};

const monitor = {
  id: "site-home", name: "Site", url: "https://example.com", enabled: true, group: null, groupId: null,
  method: "GET" as const, intervalMinutes: 1 as const, timeoutMs: 8_000,
  expectedStatus: { minimum: 200, maximum: 399 }, failureThreshold: 2, recoveryThreshold: 2, recipients: [],
};

function request(body: unknown, key = crypto.randomUUID()) {
  return new Request("https://pulse.test/api/v1/monitors", {
    method: "POST",
    headers: { "Idempotency-Key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  idempotencyRecords.clear();
  vi.mocked(authorize).mockReset().mockResolvedValue(context);
  vi.mocked(createMonitor).mockReset();
});

describe("POST /api/v1/monitors", () => {
  it("creates a monitor", async () => {
    vi.mocked(createMonitor).mockResolvedValue(monitor);
    const response = await POST(request({ id: "site-home", name: "Site", url: "https://example.com" }));
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.kind).toBe("Monitor");
    expect(payload.data.id).toBe("site-home");
  });

  it("stores a deterministic MONITOR_EXISTS error as the operation's own completed response", async () => {
    vi.mocked(createMonitor).mockRejectedValue(new MonitorApiError("MONITOR_EXISTS", "A monitor with this ID already exists"));
    const key = crypto.randomUUID();
    const response = await POST(request({ id: "site-home", name: "Site", url: "https://example.com" }, key));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("MONITOR_EXISTS");
    const stored = idempotencyRecords.get(key);
    expect(stored?.status).toBe(409);
  });

  it("lets a transient CONFIGURATION_UNAVAILABLE error propagate, leaving no completed record", async () => {
    vi.mocked(createMonitor).mockRejectedValue(new MonitorApiError("CONFIGURATION_UNAVAILABLE", "Configuration store is unavailable"));
    const key = crypto.randomUUID();
    const response = await POST(request({ id: "site-home", name: "Site", url: "https://example.com" }, key));
    expect(response.status).toBe(503);
    expect(idempotencyRecords.has(key)).toBe(false);
  });

  it("replays a stored MONITOR_EXISTS response on retry without re-invoking createMonitor", async () => {
    vi.mocked(createMonitor).mockRejectedValue(new MonitorApiError("MONITOR_EXISTS", "A monitor with this ID already exists"));
    const key = crypto.randomUUID();
    const first = await POST(request({ id: "site-home", name: "Site", url: "https://example.com" }, key));
    expect(first.status).toBe(409);
    expect(createMonitor).toHaveBeenCalledTimes(1);

    const second = await POST(request({ id: "site-home", name: "Site", url: "https://example.com" }, key));
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("MONITOR_EXISTS");
    expect(createMonitor).toHaveBeenCalledTimes(1);
  });
});
