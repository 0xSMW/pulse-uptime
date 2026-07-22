import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { digestBearerToken } from "@/lib/api/tokens"

import {
  type AcceptInviteInput,
  type AcceptInviteStore,
  acceptUserInvite,
  TeamServiceError,
  validateInviteRole,
} from "./invites"

beforeEach(() => {
  vi.stubEnv("API_TOKEN_HASH_KEY", "test-key-with-at-least-32-characters")
})

const fastHash = async (password: string) => `digest:${password}`

function fakeStore(overrides: Partial<AcceptInviteStore> = {}) {
  const accepted: AcceptInviteInput[] = []
  const store: AcceptInviteStore = {
    hasPendingInvite: async () => true,
    accept: async (input) => {
      accepted.push(input)
      return "accepted"
    },
    ...overrides,
  }
  return { store, accepted }
}

function uniqueViolation(): Error {
  const error = new Error("duplicate key value violates unique constraint")
  ;(error as Error & { code: string }).code = "23505"
  return error
}

describe("invite role validation", () => {
  it("accepts only the two shipped roles", () => {
    expect(validateInviteRole("admin")).toBe("admin")
    expect(validateInviteRole("viewer")).toBe("viewer")
    for (const bad of ["owner", "", 7, null, undefined, ["admin"]]) {
      expect(() => validateInviteRole(bad)).toThrowError(TeamServiceError)
    }
  })
})

describe("invite acceptance", () => {
  const valid = {
    token: "pulse_join_secret",
    email: " New.User@Example.COM ",
    password: "long-enough-password",
    passwordConfirmation: "long-enough-password",
    name: "  Dana  ",
  }

  it("rejects malformed input before any store work", async () => {
    const { store } = fakeStore({
      hasPendingInvite: vi.fn(async () => {
        throw new Error("store must not be reached")
      }),
    })
    const cases = [
      { ...valid, email: "not-an-email" },
      { ...valid, password: "short", passwordConfirmation: "short" },
      { ...valid, passwordConfirmation: "different-password-here" },
    ]
    for (const input of cases) {
      await expect(
        acceptUserInvite(input, { store, hash: fastHash })
      ).rejects.toMatchObject({ code: "INVALID_INPUT" })
    }
  })

  it("gates the expensive hash behind a pending-invite read", async () => {
    const hash = vi.fn(fastHash)
    const { store } = fakeStore({ hasPendingInvite: async () => false })
    await expect(
      acceptUserInvite(valid, { store, hash })
    ).rejects.toMatchObject({ code: "INVITE_INVALID" })
    expect(hash).not.toHaveBeenCalled()
  })

  it("rejects oversized tokens without hashing", async () => {
    const hash = vi.fn(fastHash)
    const { store } = fakeStore()
    await expect(
      acceptUserInvite({ ...valid, token: "x".repeat(129) }, { store, hash })
    ).rejects.toMatchObject({ code: "INVITE_INVALID" })
    expect(hash).not.toHaveBeenCalled()
  })

  it("claims the invite with the token digest and creates the session", async () => {
    const now = new Date("2026-07-22T00:00:00Z")
    const { store, accepted } = fakeStore()
    const result = await acceptUserInvite(valid, {
      store,
      hash: fastHash,
      now: () => now,
    })
    expect(accepted).toHaveLength(1)
    const input = accepted[0]!
    expect(input.digest).toEqual(digestBearerToken("pulse_join_secret"))
    expect(input.email).toBe("new.user@example.com")
    expect(input.name).toBe("Dana")
    expect(input.passwordDigest).toBe("digest:long-enough-password")
    expect(input.userId).toBe(result.userId)
    expect(result.sessionToken).toBeTruthy()
    expect(result.expiresAt.getTime()).toBeGreaterThan(now.getTime())
    expect(input.sessionExpiresAt).toEqual(result.expiresAt)
  })

  it("maps a duplicate email to EMAIL_IN_USE", async () => {
    const { store } = fakeStore({
      accept: async () => {
        throw uniqueViolation()
      },
    })
    await expect(
      acceptUserInvite(valid, { store, hash: fastHash })
    ).rejects.toMatchObject({ code: "EMAIL_IN_USE" })
  })

  it("maps a nested duplicate-email cause to EMAIL_IN_USE", async () => {
    const { store } = fakeStore({
      accept: async () => {
        throw new Error("transaction failed", { cause: uniqueViolation() })
      },
    })
    await expect(
      acceptUserInvite(valid, { store, hash: fastHash })
    ).rejects.toMatchObject({ code: "EMAIL_IN_USE" })
  })

  it("reports a lost claim race as an invalid invite", async () => {
    const { store } = fakeStore({ accept: async () => "invite-gone" })
    await expect(
      acceptUserInvite(valid, { store, hash: fastHash })
    ).rejects.toMatchObject({ code: "INVITE_INVALID" })
  })

  it("stores a null name when the field is blank", async () => {
    const { store, accepted } = fakeStore()
    await acceptUserInvite({ ...valid, name: "   " }, { store, hash: fastHash })
    expect(accepted[0]!.name).toBeNull()
  })
})
