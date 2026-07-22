import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: {} }))
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/auth/session", () => ({
  authenticateCurrentSession: vi.fn(),
  expiredSessionCookie: vi.fn(() => ({
    name: "__Host-pulse_session",
    value: "",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: true,
    path: "/",
    expires: new Date(0),
  })),
}))
vi.mock("@/lib/api/account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/account")>()),
  changeAccountPassword: vi.fn(),
}))

import { AccountServiceError, changeAccountPassword } from "@/lib/api/account"
import { type ApiContext, authorize } from "@/lib/api/middleware"
import {
  authenticateCurrentSession,
  expiredSessionCookie,
} from "@/lib/auth/session"

import { POST } from "./route"

const humanContext: ApiContext = {
  principal: {
    type: "human",
    role: "admin" as const,
    id: "user-1",
    email: "admin@example.com",
    scopes: [],
  },
  principalKey: "human:user-1",
  requestId: "req_password",
}

const session = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  userId: "user-1",
  email: "admin@example.com",
  role: "admin" as const,
  timezone: null,
  expiresAt: new Date("2026-08-01T00:00:00Z"),
  onboardingCompletedAt: new Date("2026-07-01T00:00:00Z"),
}

function passwordRequest(body: unknown) {
  return new Request("https://pulse.test/api/v1/me/password", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.mocked(authorize).mockResolvedValue(humanContext)
  vi.mocked(authenticateCurrentSession).mockResolvedValue(session)
  vi.mocked(changeAccountPassword).mockReset()
})

describe("POST /api/v1/me/password", () => {
  it("refuses bearer principals with SESSION_REQUIRED", async () => {
    vi.mocked(authorize).mockResolvedValue({
      ...humanContext,
      principal: {
        type: "api_token",
        id: "tok-1",
        name: "agent",
        scopes: [],
        expiresAt: new Date(),
      },
    })
    const response = await POST(
      passwordRequest({
        currentPassword: "old",
        newPassword: "new-password-123",
      })
    )
    expect(response.status).toBe(403)
    const payload = await response.json()
    expect(payload.error.code).toBe("SESSION_REQUIRED")
    expect(changeAccountPassword).not.toHaveBeenCalled()
  })

  it("threads the session and first forwarded hop into the service", async () => {
    vi.mocked(changeAccountPassword).mockResolvedValue({ changed: true })
    const response = await POST(
      passwordRequest({
        currentPassword: "old-password-12",
        newPassword: "new-password-123",
      })
    )
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.kind).toBe("PasswordChange")
    expect(payload.data).toEqual({ changed: true, reauthenticate: true })
    expect(changeAccountPassword).toHaveBeenCalledWith({
      currentPassword: "old-password-12",
      newPassword: "new-password-123",
      userId: "user-1",
      currentSessionId: session.sessionId,
      ip: "203.0.113.7",
    })
    expect(expiredSessionCookie).toHaveBeenCalled()
    const setCookie = response.headers.get("set-cookie") ?? ""
    expect(setCookie).toContain("__Host-pulse_session=")
    expect(setCookie.toLowerCase()).toMatch(/expires=thu, 01 jan 1970/)
  })

  it("prefers the platform-set x-real-ip over x-forwarded-for", async () => {
    vi.mocked(changeAccountPassword).mockResolvedValue({ changed: true })
    await POST(
      new Request("https://pulse.test/api/v1/me/password", {
        method: "POST",
        headers: {
          "x-real-ip": "198.51.100.9",
          "x-forwarded-for": "203.0.113.7, 10.0.0.1",
        },
        body: JSON.stringify({
          currentPassword: "old-password-12",
          newPassword: "new-password-123",
        }),
      })
    )
    expect(changeAccountPassword).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "198.51.100.9" })
    )
  })

  it("maps a wrong current password to 403", async () => {
    vi.mocked(changeAccountPassword).mockRejectedValue(
      new AccountServiceError(
        "INVALID_PASSWORD",
        "Current password is incorrect"
      )
    )
    const response = await POST(
      passwordRequest({
        currentPassword: "wrong",
        newPassword: "new-password-123",
      })
    )
    expect(response.status).toBe(403)
    const payload = await response.json()
    expect(payload.error.code).toBe("INVALID_PASSWORD")
  })

  it("maps a policy violation to 400", async () => {
    vi.mocked(changeAccountPassword).mockRejectedValue(
      new AccountServiceError("PASSWORD_POLICY", "Use at least 12 characters")
    )
    const response = await POST(
      passwordRequest({ currentPassword: "old", newPassword: "short" })
    )
    expect(response.status).toBe(400)
    const payload = await response.json()
    expect(payload.error.code).toBe("PASSWORD_POLICY")
  })

  it("returns 429 with Retry-After when the login limiter blocks", async () => {
    vi.mocked(changeAccountPassword).mockRejectedValue(
      new AccountServiceError(
        "RATE_LIMITED",
        "Too many attempts. Try again later.",
        42
      )
    )
    const response = await POST(
      passwordRequest({
        currentPassword: "old",
        newPassword: "new-password-123",
      })
    )
    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("42")
  })

  it("rejects unsupported body fields before calling the service", async () => {
    const response = await POST(
      passwordRequest({
        currentPassword: "old",
        newPassword: "new-password-123",
        extra: 1,
      })
    )
    expect(response.status).toBe(400)
    expect(changeAccountPassword).not.toHaveBeenCalled()
  })

  it("maps a lost password CAS to 409 ACCOUNT_CHANGED without expiring the cookie", async () => {
    vi.mocked(changeAccountPassword).mockRejectedValue(
      new AccountServiceError(
        "ACCOUNT_CHANGED",
        "Account details changed. Refresh and try again."
      )
    )
    const response = await POST(
      passwordRequest({
        currentPassword: "old-password-12",
        newPassword: "new-password-123",
      })
    )
    expect(response.status).toBe(409)
    const payload = await response.json()
    expect(payload.error.code).toBe("ACCOUNT_CHANGED")
    expect(response.headers.get("set-cookie")).toBeNull()
  })
})
