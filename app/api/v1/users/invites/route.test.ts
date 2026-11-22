import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: {} }))
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/api/idempotency", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/idempotency")>()),
  executeIdempotent: vi.fn(
    async (input: {
      replayBody: (
        stored: unknown,
        context: { operationId: string }
      ) => Promise<unknown> | unknown
    }) => ({
      status: 201,
      body: await input.replayBody(
        {
          id: "11111111-1111-4111-8111-111111111111",
          role: "admin",
          createdAt: "2026-11-14T00:00:00.000Z",
          expiresAt: "2026-11-21T00:00:00.000Z",
        },
        { operationId: "22222222-2222-4222-8222-222222222222" }
      ),
      replayed: true,
    })
  ),
}))
vi.mock("@/lib/auth/invites", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/invites")>()),
  requireReplayableUserInvite: vi.fn(),
}))
vi.mock("@/lib/api/tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/tokens")>()),
  deriveBearerToken: vi.fn(() => ({
    raw: "pulse_invite_stashed-secret",
    prefix: "pulse_invite_stashed",
    digest: Buffer.alloc(32, 8),
  })),
}))

import { authorize } from "@/lib/api/middleware"
import {
  requireReplayableUserInvite,
  TeamServiceError,
} from "@/lib/auth/invites"
import { POST } from "./route"

const principal = {
  type: "human" as const,
  id: "33333333-3333-4333-8333-333333333333",
  sessionId: "44444444-4444-4444-8444-444444444444",
  email: "admin@example.com",
  role: "admin" as const,
  scopes: ["users:manage" as const],
}

beforeEach(() => {
  vi.mocked(authorize).mockResolvedValue({
    principal,
    principalKey: `human:${principal.id}`,
    requestId: "invite-replay",
  })
  vi.mocked(requireReplayableUserInvite).mockRejectedValue(
    new TeamServiceError(
      "ACTOR_DENIED",
      "Administrator access is no longer active"
    )
  )
})

describe("POST /api/v1/users/invites replay", () => {
  it("does not return a completed admin invite secret after creator session revocation", async () => {
    const request = new Request("https://pulse.test/api/v1/users/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "55555555-5555-4555-8555-555555555555",
      },
      body: JSON.stringify({ role: "admin" }),
    })
    const response = await POST(request)

    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("ACTOR_DENIED")
    expect(requireReplayableUserInvite).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      Buffer.alloc(32, 8),
      principal
    )
  })
})
