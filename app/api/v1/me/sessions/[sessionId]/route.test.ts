import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentSession: vi.fn() }));

import { authorize, type ApiContext } from "@/lib/api/middleware";
import { getCurrentSession } from "@/lib/auth/session";

import { DELETE } from "./route";

const CURRENT_SESSION_ID = "11111111-1111-4111-8111-111111111111";

const humanContext: ApiContext = {
  principal: { type: "human", id: "user-1", email: "admin@example.com", scopes: [] },
  principalKey: "human:user-1",
  requestId: "req_sessions",
};

const session = {
  sessionId: CURRENT_SESSION_ID,
  userId: "user-1",
  email: "admin@example.com",
  timezone: null,
  expiresAt: new Date("2026-08-01T00:00:00Z"),
  onboardingCompletedAt: new Date("2026-07-01T00:00:00Z"),
};

function revokeRequest(sessionId: string) {
  const request = new Request(`https://pulse.test/api/v1/me/sessions/${sessionId}`, { method: "DELETE" });
  return DELETE(request, { params: Promise.resolve({ sessionId }) });
}

beforeEach(() => {
  vi.mocked(authorize).mockResolvedValue(humanContext);
  vi.mocked(getCurrentSession).mockResolvedValue(session);
});

describe("DELETE /api/v1/me/sessions/{sessionId}", () => {
  it("refuses bearer principals with SESSION_REQUIRED", async () => {
    vi.mocked(authorize).mockResolvedValue({
      ...humanContext,
      principal: { type: "api_token", id: "tok-1", name: "agent", scopes: [], expiresAt: new Date() },
    });
    const response = await revokeRequest(CURRENT_SESSION_ID);
    expect(response.status).toBe(403);
    const payload = await response.json();
    expect(payload.error.code).toBe("SESSION_REQUIRED");
  });

  it("rejects malformed session ids", async () => {
    const response = await revokeRequest("not-a-uuid");
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("INVALID_SESSION");
  });

  it("refuses to revoke the current session with 409", async () => {
    const response = await revokeRequest(CURRENT_SESSION_ID);
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.error.code).toBe("CURRENT_SESSION");
  });
});
