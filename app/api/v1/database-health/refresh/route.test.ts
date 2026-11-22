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
vi.mock("@/lib/api/live-authority", () => ({ hasLiveScope: vi.fn() }))
vi.mock("@/lib/api/idempotency", () => ({
  executeIdempotent: vi.fn(
    async ({ work }: { work: () => Promise<unknown> }) => ({
      ...((await work()) as object),
      replayed: false,
    })
  ),
}))
vi.mock("@/lib/database-health", () => ({
  DatabaseHealthUnavailableError: class DatabaseHealthUnavailableError extends Error {},
  refreshDatabaseHealth: vi.fn(),
}))

import { hasLiveScope } from "@/lib/api/live-authority"
import { type ApiContext, authorize } from "@/lib/api/middleware"
import { refreshDatabaseHealth } from "@/lib/database-health"

import { POST } from "./route"

const context: ApiContext = {
  principal: {
    type: "api_token",
    id: "11111111-1111-4111-8111-111111111111",
    name: "admin-token",
    scopes: ["config:write"],
    expiresAt: new Date("2099-01-01T00:00:00Z"),
  },
  principalKey: "api_token:11111111-1111-4111-8111-111111111111",
  requestId: "req_db_health",
}

function request() {
  return new Request("https://pulse.test/api/v1/database-health/refresh", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
  })
}

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context)
  vi.mocked(hasLiveScope).mockReset().mockResolvedValue(true)
  vi.mocked(refreshDatabaseHealth)
    .mockReset()
    .mockResolvedValue({ refreshStatus: "CAPTURED" } as never)
})

describe("POST /api/v1/database-health/refresh", () => {
  it("denies a credential revoked after route authorization before capturing health", async () => {
    vi.mocked(hasLiveScope).mockResolvedValue(false)

    const response = await POST(request())

    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("SCOPE_DENIED")
    expect(refreshDatabaseHealth).not.toHaveBeenCalled()
  })

  it("captures health while authority is held live", async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(hasLiveScope).toHaveBeenCalledWith(
      expect.objectContaining({ rollback: expect.any(Function) }),
      context.principal,
      "config:write"
    )
    expect(refreshDatabaseHealth).toHaveBeenCalledOnce()
  })
})
