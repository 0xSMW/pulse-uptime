import { beforeEach, describe, expect, it, vi } from "vitest"

const completed = vi.hoisted(
  () => new Map<string, { status: number; body: unknown }>()
)

vi.mock("server-only", () => ({}))
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/api/idempotency", () => ({
  executeIdempotent: vi.fn(async ({ request, work }) => {
    const key = request.headers.get("idempotency-key") ?? ""
    const replayed = completed.get(key)
    if (replayed) {
      return { ...replayed, replayed: true }
    }
    const result = await work()
    completed.set(key, result)
    return { ...result, replayed: false }
  }),
}))
vi.mock("@/lib/api/config-service", () => ({
  CONFIG_OPERATION_RETENTION_SECONDS: 7 * 24 * 60 * 60,
  configErrorCode: vi.fn(() => "AUTHORIZATION_REVOKED"),
  configurationService: { apply: vi.fn() },
}))

import { configErrorCode, configurationService } from "@/lib/api/config-service"
import { executeIdempotent } from "@/lib/api/idempotency"
import { type ApiContext, authorize } from "@/lib/api/middleware"

import { POST } from "./route"

const context: ApiContext = {
  principal: {
    type: "api_token",
    id: "token-1",
    name: "automation",
    scopes: ["config:write"],
    expiresAt: new Date("2030-01-01"),
  },
  principalKey: "api_token:token-1",
  requestId: "req-1",
}

beforeEach(() => {
  completed.clear()
  vi.mocked(authorize).mockReset().mockResolvedValue(context)
  vi.mocked(executeIdempotent).mockClear()
  vi.mocked(configurationService.apply).mockReset()
  vi.mocked(configErrorCode).mockClear()
})

describe("POST /api/v1/config/apply", () => {
  it("completes and replays a 403 when authority is revoked between route authorization and the service write", async () => {
    vi.mocked(configurationService.apply).mockRejectedValue(
      new Error("revoked after authorize")
    )
    const request = new Request("https://pulse.test/api/v1/config/apply", {
      method: "POST",
      headers: { "Idempotency-Key": "key-1" },
      body: JSON.stringify({ targetConfig: {} }),
    })

    const response = await POST(request)

    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("AUTHORIZATION_REVOKED")
    expect(completed.get("key-1")).toMatchObject({
      status: 403,
      body: { error: { code: "AUTHORIZATION_REVOKED" } },
    })
    expect(authorize).toHaveBeenCalledWith(request, {
      scope: "config:write",
    })
    expect(configurationService.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: context.principal,
        principalKey: context.principalKey,
      })
    )

    const replay = await POST(
      new Request("https://pulse.test/api/v1/config/apply", {
        method: "POST",
        headers: { "Idempotency-Key": "key-1" },
        body: JSON.stringify({ targetConfig: {} }),
      })
    )
    expect(replay.status).toBe(403)
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true")
    expect((await replay.json()).error.code).toBe("AUTHORIZATION_REVOKED")
    expect(configurationService.apply).toHaveBeenCalledOnce()
  })
})
