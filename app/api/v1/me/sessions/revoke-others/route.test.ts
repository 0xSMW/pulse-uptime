import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentSession: vi.fn() }));
vi.mock("@/lib/api/account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/account")>()),
  revokeOtherAccountSessions: vi.fn(),
}));

import { revokeOtherAccountSessions } from "@/lib/api/account";
import { authorize, type ApiContext } from "@/lib/api/middleware";
import { getCurrentSession } from "@/lib/auth/session";

import { POST } from "./route";

const humanContext: ApiContext = {
  principal: { type: "human", id: "user-1", email: "admin@example.com", scopes: [] },
  principalKey: "human:user-1",
  requestId: "req_revoke_others",
};

const session = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  userId: "user-1",
  email: "admin@example.com",
  timezone: null,
  expiresAt: new Date("2026-08-01T00:00:00Z"),
  onboardingCompletedAt: new Date("2026-07-01T00:00:00Z"),
};

function revokeOthersRequest() {
  return POST(new Request("https://pulse.test/api/v1/me/sessions/revoke-others", { method: "POST" }));
}

beforeEach(() => {
  vi.mocked(authorize).mockResolvedValue(humanContext);
  vi.mocked(getCurrentSession).mockResolvedValue(session);
  vi.mocked(revokeOtherAccountSessions).mockReset();
});

describe("POST /api/v1/me/sessions/revoke-others", () => {
  it("refuses bearer principals with SESSION_REQUIRED", async () => {
    vi.mocked(authorize).mockResolvedValue({
      ...humanContext,
      principal: { type: "api_token", id: "tok-1", name: "agent", scopes: [], expiresAt: new Date() },
    });
    const response = await revokeOthersRequest();
    expect(response.status).toBe(403);
    const payload = await response.json();
    expect(payload.error.code).toBe("SESSION_REQUIRED");
    expect(revokeOtherAccountSessions).not.toHaveBeenCalled();
  });

  it("revokes everything except the current session and reports the count", async () => {
    vi.mocked(revokeOtherAccountSessions).mockResolvedValue({ revokedCount: 3 });
    const response = await revokeOthersRequest();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.kind).toBe("SessionRevocation");
    expect(payload.data).toEqual({ revokedCount: 3 });
    expect(revokeOtherAccountSessions).toHaveBeenCalledWith({
      userId: "user-1",
      currentSessionId: session.sessionId,
    });
  });
});
