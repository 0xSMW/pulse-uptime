import { beforeEach, describe, expect, it, vi } from "vitest"

const { authenticateCurrentSession } = vi.hoisted(() => ({
  authenticateCurrentSession: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/auth/session", () => ({ authenticateCurrentSession }))

import { authenticatedAdminMutation } from "./http"

function request(): Request {
  return new Request("https://pulse.example/api/onboarding/verify", {
    method: "POST",
    headers: { origin: "https://pulse.example" },
  })
}

const session = {
  sessionId: "session-1",
  userId: "user-1",
  email: "admin@example.com",
  timezone: null,
  expiresAt: new Date("2026-09-01T00:00:00Z"),
  onboardingCompletedAt: null,
}

describe("authenticated onboarding administrator mutation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("rejects a viewer before onboarding probe work can start", async () => {
    authenticateCurrentSession.mockResolvedValue({
      ...session,
      role: "viewer",
    })

    const auth = await authenticatedAdminMutation(request())

    expect(auth.session).toBeNull()
    expect(auth.response?.status).toBe(403)
    await expect(auth.response?.json()).resolves.toEqual({
      error: "Administrator access required",
    })
  })

  it("preserves the administrator session for onboarding probes", async () => {
    authenticateCurrentSession.mockResolvedValue({
      ...session,
      role: "admin",
    })

    const auth = await authenticatedAdminMutation(request())

    expect(auth.response).toBeNull()
    expect(auth.session).toMatchObject({ userId: "user-1", role: "admin" })
  })
})
