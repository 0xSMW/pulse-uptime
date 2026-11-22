import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/auth/session", () => ({
  authenticateCurrentSession: vi.fn(),
}))
vi.mock("@/lib/api/device-authorization", () => ({
  approveDeviceAuthorization: vi.fn(),
  denyDeviceAuthorization: vi.fn(),
  expireStaleDeviceAuthorizations: vi.fn(),
  findPendingDeviceAuthorization: vi.fn(),
}))

import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  expireStaleDeviceAuthorizations,
  findPendingDeviceAuthorization,
} from "@/lib/api/device-authorization"
import { authenticateCurrentSession } from "@/lib/auth/session"
import {
  approveAuthorization,
  denyAuthorization,
  lookupAuthorization,
} from "./actions"

const code = "ABCD-1234"
const admin = {
  userId: "user-1",
  sessionId: "session-1",
  email: "admin@example.com",
  role: "admin" as const,
}
const pending = {
  userCode: code,
  clientName: "pulsectl",
  installationName: "Laptop",
  clientVersion: "1.0.0",
  platform: "darwin",
  architecture: "arm64",
  requestIp: "203.0.113.10",
  expiresAt: new Date("2026-11-14T20:00:00.000Z"),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findPendingDeviceAuthorization).mockResolvedValue(pending as never)
})

describe("CLI authorization Server Actions", () => {
  it.each([
    {
      role: "anonymous",
      session: null,
      expected: { ok: false, signedOut: true, message: "Sign in to continue" },
    },
    {
      role: "viewer",
      session: { ...admin, role: "viewer" },
      expected: { ok: false, message: "Only admins can authorize CLI access" },
    },
  ])(
    "rejects direct $role calls before device service work",
    async ({ session, expected }) => {
      vi.mocked(authenticateCurrentSession).mockResolvedValue(session as never)

      for (const action of [
        lookupAuthorization,
        approveAuthorization,
        denyAuthorization,
      ]) {
        await expect(action(code)).resolves.toEqual(expected)
      }

      expect(expireStaleDeviceAuthorizations).not.toHaveBeenCalled()
      expect(findPendingDeviceAuthorization).not.toHaveBeenCalled()
      expect(approveDeviceAuthorization).not.toHaveBeenCalled()
      expect(denyDeviceAuthorization).not.toHaveBeenCalled()
    }
  )

  it("forwards an admin lookup and returns only the display fields", async () => {
    vi.mocked(authenticateCurrentSession).mockResolvedValue(admin as never)

    const result = await lookupAuthorization(code)

    expect(result).toEqual({
      ok: true,
      request: {
        ...pending,
        expiresAt: pending.expiresAt.toISOString(),
      },
    })
    expect(expireStaleDeviceAuthorizations).toHaveBeenCalledWith(
      code,
      expect.any(Date)
    )
    expect(findPendingDeviceAuthorization).toHaveBeenCalledWith(
      code,
      expect.any(Date)
    )
    expect(approveDeviceAuthorization).not.toHaveBeenCalled()
    expect(denyDeviceAuthorization).not.toHaveBeenCalled()
  })

  it("forwards admin approval with the live human identity", async () => {
    vi.mocked(authenticateCurrentSession).mockResolvedValue(admin as never)

    await expect(approveAuthorization(code)).resolves.toEqual({
      ok: true,
      state: "approved",
    })
    expect(approveDeviceAuthorization).toHaveBeenCalledWith(code, {
      id: admin.userId,
      sessionId: admin.sessionId,
      email: admin.email,
    })
    expect(denyDeviceAuthorization).not.toHaveBeenCalled()
  })

  it("forwards admin denial with the live human identity", async () => {
    vi.mocked(authenticateCurrentSession).mockResolvedValue(admin as never)

    await expect(denyAuthorization(code)).resolves.toEqual({
      ok: true,
      state: "denied",
    })
    expect(denyDeviceAuthorization).toHaveBeenCalledWith(code, {
      id: admin.userId,
      sessionId: admin.sessionId,
      email: admin.email,
    })
    expect(approveDeviceAuthorization).not.toHaveBeenCalled()
  })
})
