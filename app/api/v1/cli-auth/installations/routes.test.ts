import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/api/idempotency", () => ({
  executeIdempotent: vi.fn(
    async (input: {
      work: (tx: unknown) => Promise<{ status: number; body: unknown }>
    }) => ({
      ...(await input.work({})),
      replayed: false,
    })
  ),
}))
vi.mock("@/lib/api/device-authorization", () => ({
  revokeCliInstallationById: vi.fn(),
  revokeAllMachineCredentials: vi.fn(),
}))

import {
  revokeAllMachineCredentials,
  revokeCliInstallationById,
} from "@/lib/api/device-authorization"
import { type ApiContext, authorize } from "@/lib/api/middleware"

import { DELETE } from "./[installationId]/route"
import { POST } from "./revoke-all/route"

const installationId = "11111111-1111-4111-8111-111111111111"
const humanContext: ApiContext = {
  principal: {
    type: "human",
    role: "admin",
    id: "user-1",
    sessionId: "session-1",
    email: "admin@example.com",
    scopes: ["tokens:manage"],
  },
  principalKey: "human:user-1",
  requestId: "req_machine_revoke",
}

beforeEach(() => {
  vi.mocked(authorize).mockResolvedValue(humanContext)
  vi.mocked(revokeCliInstallationById).mockReset()
  vi.mocked(revokeAllMachineCredentials).mockReset()
})

describe("administrator machine credential revocation", () => {
  it("requires a human dashboard session", async () => {
    vi.mocked(authorize).mockResolvedValue({
      ...humanContext,
      principal: {
        type: "api_token",
        id: "token-1",
        name: "agent",
        scopes: ["tokens:manage"],
        expiresAt: new Date("2027-01-01T00:00:00Z"),
      },
    })

    const response = await POST(
      new Request(
        "https://pulse.test/api/v1/cli-auth/installations/revoke-all",
        {
          method: "POST",
        }
      )
    )

    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("SESSION_REQUIRED")
    expect(revokeAllMachineCredentials).not.toHaveBeenCalled()
  })

  it("revokes one installation and its descendants", async () => {
    vi.mocked(revokeCliInstallationById).mockResolvedValue({
      installations: 1,
      sessions: 2,
      tokens: 3,
    })

    const response = await DELETE(
      new Request(
        `https://pulse.test/api/v1/cli-auth/installations/${installationId}`,
        { method: "DELETE" }
      ),
      { params: Promise.resolve({ installationId }) }
    )

    expect(response.status).toBe(200)
    expect((await response.json()).data).toEqual({
      installations: 1,
      sessions: 2,
      tokens: 3,
    })
  })

  it("revokes every machine credential as an emergency action", async () => {
    vi.mocked(revokeAllMachineCredentials).mockResolvedValue({
      installations: 4,
      sessions: 5,
      tokens: 6,
    })

    const response = await POST(
      new Request(
        "https://pulse.test/api/v1/cli-auth/installations/revoke-all",
        {
          method: "POST",
        }
      )
    )

    expect(response.status).toBe(200)
    expect((await response.json()).data).toEqual({
      installations: 4,
      sessions: 5,
      tokens: 6,
    })
  })
})
