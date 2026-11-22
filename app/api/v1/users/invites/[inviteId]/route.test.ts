import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/api/idempotency", () => ({
  executeIdempotent: vi.fn(
    async ({ work }: { work: (tx: unknown) => Promise<unknown> }) => ({
      ...((await work({ rollback: vi.fn() })) as object),
      replayed: false,
    })
  ),
}))
vi.mock("@/lib/api/live-authority", () => ({ hasLiveScope: vi.fn() }))
vi.mock("@/lib/auth/invites", () => ({
  TeamServiceError: class TeamServiceError extends Error {},
  revokeUserInvite: vi.fn(),
}))

import { hasLiveScope } from "@/lib/api/live-authority"
import { type ApiContext, authorize } from "@/lib/api/middleware"
import { revokeUserInvite } from "@/lib/auth/invites"

import { DELETE } from "./route"

const inviteId = "11111111-1111-4111-8111-111111111111"
const context: ApiContext = {
  principal: {
    type: "human",
    id: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    email: "admin@example.com",
    role: "admin",
    scopes: ["users:manage"],
  },
  principalKey: "human:22222222-2222-4222-8222-222222222222",
  requestId: "req_invite_revoke",
}

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context)
  vi.mocked(hasLiveScope).mockReset().mockResolvedValue(true)
  vi.mocked(revokeUserInvite).mockReset().mockResolvedValue({ id: inviteId })
})

describe("DELETE /api/v1/users/invites/{inviteId} temporal authority", () => {
  it("rejects a stale administrator before changing a pending invitation", async () => {
    vi.mocked(hasLiveScope).mockResolvedValue(false)

    const response = await DELETE(
      new Request(`https://pulse.test/api/v1/users/invites/${inviteId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ inviteId }) }
    )

    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("SCOPE_DENIED")
    expect(revokeUserInvite).not.toHaveBeenCalled()
  })

  it("revokes an invite while the administrator remains live", async () => {
    const response = await DELETE(
      new Request(`https://pulse.test/api/v1/users/invites/${inviteId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ inviteId }) }
    )

    expect(response.status).toBe(200)
    expect(revokeUserInvite).toHaveBeenCalledOnce()
  })
})
