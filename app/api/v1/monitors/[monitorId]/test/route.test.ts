import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({
  db: {
    transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
      work({ rollback: vi.fn() })
    ),
  },
}))
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/api/rate-limit", () => ({
  enforceRateLimit: vi.fn(async () => ({
    allowed: true,
    remaining: 1,
    retryAfterSeconds: 0,
  })),
}))
vi.mock("@/lib/api/live-authority", () => ({ hasLiveScope: vi.fn() }))
vi.mock("@/lib/api/idempotency", () => ({
  executeIdempotent: vi.fn(
    async ({ work }: { work: () => Promise<unknown> }) => ({
      ...((await work()) as object),
      replayed: false,
    })
  ),
}))
vi.mock("@/lib/api/monitors", () => ({
  MonitorApiError: class MonitorApiError extends Error {},
  testMonitor: vi.fn(),
}))

import { hasLiveScope } from "@/lib/api/live-authority"
import { type ApiContext, authorize } from "@/lib/api/middleware"
import { testMonitor } from "@/lib/api/monitors"

import { POST } from "./route"

const context: ApiContext = {
  principal: {
    type: "human",
    id: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    email: "admin@example.com",
    role: "admin",
    scopes: ["monitors:write"],
  },
  principalKey: "human:11111111-1111-4111-8111-111111111111",
  requestId: "req_monitor_test",
}
const params = { params: Promise.resolve({ monitorId: "site-home" }) }

function request() {
  return new Request("https://pulse.test/api/v1/monitors/site-home/test", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
  })
}

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context)
  vi.mocked(hasLiveScope).mockReset().mockResolvedValue(true)
  vi.mocked(testMonitor)
    .mockReset()
    .mockResolvedValue({ state: "UP" } as never)
})

describe("POST /api/v1/monitors/{monitorId}/test", () => {
  it("denies a revoked caller before starting an external monitor probe", async () => {
    vi.mocked(hasLiveScope).mockResolvedValue(false)

    const response = await POST(request(), params)

    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("SCOPE_DENIED")
    expect(testMonitor).not.toHaveBeenCalled()
  })

  it("holds live authority through a permitted probe", async () => {
    const response = await POST(request(), params)

    expect(response.status).toBe(200)
    expect(hasLiveScope).toHaveBeenCalledWith(
      expect.objectContaining({ rollback: expect.any(Function) }),
      context.principal,
      "monitors:write"
    )
    expect(testMonitor).toHaveBeenCalledWith("site-home")
  })
})
