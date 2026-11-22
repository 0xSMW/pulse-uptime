import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/api/idempotency", () => ({ executeIdempotent: vi.fn() }))
vi.mock("@/lib/api/live-authority", () => ({ hasLiveScope: vi.fn() }))
vi.mock("@/lib/api/token-service", () => ({ revokeApiToken: vi.fn() }))

import { executeIdempotent } from "@/lib/api/idempotency"
import { hasLiveScope } from "@/lib/api/live-authority"
import { type ApiContext, authorize } from "@/lib/api/middleware"
import { revokeApiToken } from "@/lib/api/token-service"

import { DELETE } from "./route"

const tokenId = "11111111-1111-4111-8111-111111111111"
const context: ApiContext = {
  principal: {
    type: "human",
    id: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    email: "admin@example.com",
    role: "admin",
    scopes: ["tokens:manage"],
  },
  principalKey: "human:22222222-2222-4222-8222-222222222222",
  requestId: "req_token_revoke",
}

const request = () =>
  new Request(`https://pulse.test/api/v1/tokens/${tokenId}`, {
    method: "DELETE",
  })

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context)
  vi.mocked(hasLiveScope).mockReset().mockResolvedValue(true)
  vi.mocked(revokeApiToken)
    .mockReset()
    .mockResolvedValue({ id: tokenId, revokedAt: new Date() } as never)
  vi.mocked(executeIdempotent)
    .mockReset()
    .mockImplementation(async ({ work }) => {
      const result = await (
        work as (tx: unknown) => Promise<{ status: number; body: unknown }>
      )({ rollback: vi.fn() })
      return { ...result, replayed: false } as never
    })
})

describe("DELETE /api/v1/tokens/{tokenId} temporal authority", () => {
  it("denies revocation when the caller loses authority during idempotency acquisition", async () => {
    let releaseWork: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseWork = resolve
    })
    vi.mocked(executeIdempotent).mockImplementationOnce(async ({ work }) => {
      await gate
      const result = await (
        work as (tx: unknown) => Promise<{ status: number; body: unknown }>
      )({ rollback: vi.fn() })
      return { ...result, replayed: false } as never
    })

    const pending = DELETE(request(), { params: Promise.resolve({ tokenId }) })
    await vi.waitFor(() => expect(executeIdempotent).toHaveBeenCalledOnce())
    vi.mocked(hasLiveScope).mockResolvedValue(false)
    releaseWork?.()
    const response = await pending

    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("SCOPE_DENIED")
    expect(revokeApiToken).not.toHaveBeenCalled()
  })

  it("revokes the requested token when authority remains live", async () => {
    const response = await DELETE(request(), {
      params: Promise.resolve({ tokenId }),
    })

    expect(response.status).toBe(200)
    expect(revokeApiToken).toHaveBeenCalledOnce()
  })
})
