import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/api/rate-limit", () => ({
  enforceRateLimit: vi.fn(async () => ({ allowed: true })),
  sourceIpKey: vi.fn(() => "ip:test"),
}))
vi.mock("@/lib/api/idempotency", () => ({
  executeIdempotent: vi.fn(),
  requireIdempotencyKey: vi.fn(() => "retry-key"),
}))
vi.mock("@/lib/api/device-authorization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/device-authorization")>()),
  pollDeviceAuthorization: vi.fn(),
  requireReplayableCliSession: vi.fn(),
}))

import {
  DeviceAuthorizationError,
  requireReplayableCliSession,
} from "@/lib/api/device-authorization"
import { executeIdempotent } from "@/lib/api/idempotency"
import { POST } from "./route"

const deviceCode = "a".repeat(32)
const replayedSession = {
  outcome: "session" as const,
  tokenType: "Bearer" as const,
  expiresAt: "2026-08-14T00:00:00.000Z",
  scopes: ["monitors:read"],
}

function request() {
  return new Request("https://pulse.test/api/v1/cli-auth/token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "retry-key",
    },
    body: JSON.stringify({ deviceCode }),
  })
}

beforeEach(() => {
  process.env.DEVICE_AUTH_SECRET = "device-secret-with-at-least-32-characters"
  process.env.API_TOKEN_HASH_KEY = "api-token-key-with-at-least-32-characters"
  vi.clearAllMocks()
  vi.mocked(requireReplayableCliSession).mockResolvedValue({
    expiresAt: new Date(replayedSession.expiresAt),
    scopes: replayedSession.scopes,
    scopeProfile: null,
  })
  vi.mocked(executeIdempotent).mockImplementation(async (input) => ({
    status: 200,
    body: await input.replayBody!(replayedSession, {
      operationId: "operation-1",
    }),
    replayed: true,
  }))
})

describe("CLI token idempotency replay", () => {
  it("preserves a valid replay response", async () => {
    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toMatchObject({
      tokenType: "Bearer",
      expiresAt: replayedSession.expiresAt,
      scopes: replayedSession.scopes,
    })
    expect(body.data.token).toMatch(/^pulse_cli_/)
    expect(requireReplayableCliSession).toHaveBeenCalledOnce()
  })

  it.each([
    "revoked session",
    "expired session",
    "revoked installation",
    "stale credential epoch",
  ])("rejects replay for a %s", async () => {
    vi.mocked(requireReplayableCliSession).mockRejectedValueOnce(
      new DeviceAuthorizationError(
        "expired_token",
        "CLI session is no longer active"
      )
    )

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error.code).toBe("expired_token")
    expect(body.data).toBeUndefined()
  })
})
