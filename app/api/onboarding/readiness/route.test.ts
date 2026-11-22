import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  authenticateCurrentSession,
  enforceRateLimit,
  getOnboardingReadiness,
  hasAdministrator,
} = vi.hoisted(() => ({
  authenticateCurrentSession: vi.fn(),
  enforceRateLimit: vi.fn(),
  getOnboardingReadiness: vi.fn(),
  hasAdministrator: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/api/rate-limit", () => ({
  enforceRateLimit,
  sourceIpKey: vi.fn(() => "persistent-ip-key"),
}))
vi.mock("@/lib/auth/service", () => ({ hasAdministrator }))
vi.mock("@/lib/auth/session", () => ({ authenticateCurrentSession }))
vi.mock("@/lib/onboarding/readiness", () => ({
  getOnboardingReadiness,
  ONBOARDING_READINESS_TIMEOUT_MS: 9000,
}))

import { GET, resetReadinessAdmissionForTests } from "./route"

const setupToken = "operator-setup-token-1234567890"

function request(
  ip = "203.0.113.20",
  token: string | null = setupToken
): Request {
  return new Request("https://pulse.example/api/onboarding/readiness", {
    headers: {
      "x-real-ip": ip,
      ...(token === null ? {} : { "x-pulse-bootstrap-token": token }),
    },
  })
}

const readyReport = {
  checkedAt: "2026-08-13T00:00:00.000Z",
  expiresAt: "2026-08-13T00:01:00.000Z",
  canContinue: true,
  requiresEmailAcknowledgement: false,
  checks: [],
}

describe("GET /api/onboarding/readiness", () => {
  afterEach(() => vi.unstubAllEnvs())

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("PULSE_BOOTSTRAP_TOKEN", setupToken)
    resetReadinessAdmissionForTests()
    hasAdministrator.mockResolvedValue(false)
    authenticateCurrentSession.mockResolvedValue(null)
    enforceRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 9,
      retryAfterSeconds: 60,
    })
    getOnboardingReadiness.mockResolvedValue(readyReport)
  })

  it.each([null, "wrong-setup-token-1234567890"])(
    "rejects missing or invalid bootstrap proof before readiness work (%s)",
    async (token) => {
      const response = await GET(request("203.0.113.20", token))

      expect(response.status).toBe(403)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(hasAdministrator).not.toHaveBeenCalled()
      expect(enforceRateLimit).not.toHaveBeenCalled()
      expect(getOnboardingReadiness).not.toHaveBeenCalled()
    }
  )

  it("preserves the successful readiness response contract", async () => {
    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    await expect(response.json()).resolves.toEqual(readyReport)
    expect(hasAdministrator).toHaveBeenCalledTimes(1)
    expect(enforceRateLimit).toHaveBeenCalledTimes(1)
    expect(getOnboardingReadiness).toHaveBeenCalledTimes(1)
  })

  it("rejects a viewer before privileged readiness probes start", async () => {
    hasAdministrator.mockResolvedValue(true)
    authenticateCurrentSession.mockResolvedValue({ role: "viewer" })

    const response = await GET(request())

    expect(response.status).toBe(403)
    expect(response.headers.get("cache-control")).toBe("no-store")
    await expect(response.json()).resolves.toEqual({
      error: "Administrator access required",
    })
    expect(enforceRateLimit).not.toHaveBeenCalled()
    expect(getOnboardingReadiness).not.toHaveBeenCalled()
  })

  it("preserves readiness probes for an authenticated administrator", async () => {
    hasAdministrator.mockResolvedValue(true)
    authenticateCurrentSession.mockResolvedValue({ role: "admin" })

    const response = await GET(request("203.0.113.20", null))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(readyReport)
    expect(enforceRateLimit).toHaveBeenCalledTimes(1)
    expect(getOnboardingReadiness).toHaveBeenCalledTimes(1)
  })

  it("rejects an anonymous caller after an administrator claims the install", async () => {
    hasAdministrator.mockResolvedValue(true)

    const response = await GET(request())

    expect(response.status).toBe(410)
    expect(enforceRateLimit).not.toHaveBeenCalled()
    expect(getOnboardingReadiness).not.toHaveBeenCalled()
  })

  it("fails closed when the setup token is unconfigured", async () => {
    vi.stubEnv("PULSE_BOOTSTRAP_TOKEN", "")

    const response = await GET(request())

    expect(response.status).toBe(403)
    expect(hasAdministrator).not.toHaveBeenCalled()
    expect(getOnboardingReadiness).not.toHaveBeenCalled()
  })

  it("rejects an abusive source before any Postgres-backed check", async () => {
    const admitted = Array.from({ length: 10 }, () => GET(request()))
    await Promise.all(admitted)
    vi.clearAllMocks()

    const response = await GET(request())

    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBeTruthy()
    expect(hasAdministrator).not.toHaveBeenCalled()
    expect(authenticateCurrentSession).not.toHaveBeenCalled()
    expect(enforceRateLimit).not.toHaveBeenCalled()
    expect(getOnboardingReadiness).not.toHaveBeenCalled()
  })
})
