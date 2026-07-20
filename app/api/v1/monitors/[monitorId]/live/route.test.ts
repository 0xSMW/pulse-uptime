import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db: {}, sql: {} }));
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}));
vi.mock("@/lib/reporting/queries/monitors", () => ({
  getMonitorLive: vi.fn(),
}));

import { authorize, type ApiContext } from "@/lib/api/middleware";
import type { ApiScope } from "@/lib/api/scopes";
import { getMonitorLive } from "@/lib/reporting/queries/monitors";

import { GET } from "./route";

function context(scopes: ApiScope[]): ApiContext {
  return {
    principal: { type: "api_token", id: "tok-1", name: "Reader", scopes, expiresAt: new Date() },
    principalKey: "api_token:tok-1",
    requestId: "req_live",
  };
}

const params = { params: Promise.resolve({ monitorId: "site-home" }) };

const live = {
  id: "site-home",
  state: "UP" as const,
  enabled: true,
  latestLatencyMs: 100,
  lastCheckedAt: null,
  p95LatencyMs: 120,
  uptime: { h24: 100, d7: 100 },
  coverage: { h24: 1, d7: 1 },
  rangeUnlocked: { h24: true, d7: true, d30: false, d90: false },
  firstRun: { phase: "active" as const, activatedAt: null, observedSeconds: 0, observed: { uptime: null, completed: 0, expected: 0 }, setupError: null, lastCheckedAt: null },
  latestIncident: null,
  recentIncidents: [],
  recentChecks: [],
  rollupVersion: null,
  configVersion: null,
  windowVersion: "2026-07-19T12:00:00.000Z",
};

function request() {
  return new Request("https://pulse.test/api/v1/monitors/site-home/live");
}

beforeEach(() => {
  vi.mocked(authorize).mockReset();
  vi.mocked(getMonitorLive).mockReset().mockResolvedValue(live);
});

describe("GET /api/v1/monitors/{monitorId}/live", () => {
  it("withholds incident fields when the principal lacks incidents:read", async () => {
    vi.mocked(authorize).mockResolvedValue(context(["monitors:read"]));
    const response = await GET(request(), params);
    expect(response.status).toBe(200);
    expect(getMonitorLive).toHaveBeenCalledWith("site-home", { includeIncidents: false });
  });

  it("includes incident fields when the principal also holds incidents:read", async () => {
    vi.mocked(authorize).mockResolvedValue(context(["monitors:read", "incidents:read"]));
    const response = await GET(request(), params);
    expect(response.status).toBe(200);
    expect(getMonitorLive).toHaveBeenCalledWith("site-home", { includeIncidents: true });
  });

  it("returns the scope-denied response from authorize without reading the monitor", async () => {
    vi.mocked(authorize).mockResolvedValue(new Response(null, { status: 403 }));
    const response = await GET(request(), params);
    expect(response.status).toBe(403);
    expect(getMonitorLive).not.toHaveBeenCalled();
  });

  it("is 404 when the monitor does not exist", async () => {
    vi.mocked(authorize).mockResolvedValue(context(["monitors:read", "incidents:read"]));
    vi.mocked(getMonitorLive).mockResolvedValue(null);
    const response = await GET(request(), params);
    expect(response.status).toBe(404);
  });
});
