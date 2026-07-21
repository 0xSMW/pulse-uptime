import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: {} }))

import {
  AccountServiceError,
  changeAccountEmail,
  changeAccountPassword,
  type EmailChangeStore,
  type PasswordChangeStore,
  type ProfileUpdateStore,
  revokeAccountSession,
  revokeOtherAccountSessions,
  type SessionRevocationStore,
  updateAccountProfile,
  validateEmailChangeInput,
  validatePasswordChangeInput,
  validateProfilePatch,
} from "./account"

describe("profile patch validation", () => {
  it("accepts a trimmed name and a valid IANA time zone", () => {
    expect(
      validateProfilePatch({ name: "  Stephen  ", timezone: "Asia/Bangkok" })
    ).toEqual({ name: "Stephen", timezone: "Asia/Bangkok" })
  })

  it("accepts a null time zone as follow-system", () => {
    expect(validateProfilePatch({ timezone: null })).toEqual({ timezone: null })
  })

  it("accepts an avatar image UUID or null and rejects other shapes", () => {
    expect(
      validateProfilePatch({
        avatarImageId: "11111111-1111-4111-8111-111111111111",
      })
    ).toEqual({ avatarImageId: "11111111-1111-4111-8111-111111111111" })
    expect(validateProfilePatch({ avatarImageId: null })).toEqual({
      avatarImageId: null,
    })
    expect(() => validateProfilePatch({ avatarImageId: "not-a-uuid" })).toThrow(
      AccountServiceError
    )
    expect(() => validateProfilePatch({ avatarImageId: 7 })).toThrow(
      AccountServiceError
    )
  })

  it("rejects unsupported fields", () => {
    expect(() => validateProfilePatch({ email: "x@example.com" })).toThrow(
      AccountServiceError
    )
  })

  it("rejects empty patches, blank names, and invalid zones", () => {
    expect(() => validateProfilePatch({})).toThrow(AccountServiceError)
    expect(() => validateProfilePatch({ name: "   " })).toThrow(
      AccountServiceError
    )
    expect(() => validateProfilePatch({ name: "a".repeat(121) })).toThrow(
      AccountServiceError
    )
    expect(() => validateProfilePatch({ timezone: "Not/AZone" })).toThrow(
      AccountServiceError
    )
    expect(() => validateProfilePatch({ timezone: "system" })).toThrow(
      AccountServiceError
    )
  })
})

const NEW_AVATAR_ID = "11111111-1111-4111-8111-111111111111"
const OLD_AVATAR_ID = "22222222-2222-4222-8222-222222222222"

function fakeProfileStore(
  overrides: Partial<ProfileUpdateStore> = {}
): ProfileUpdateStore {
  return {
    findAvatarImage: vi.fn().mockResolvedValue({ kind: "avatar" }),
    applyProfileUpdate: vi.fn().mockResolvedValue({
      name: "Stephen",
      email: "admin@example.com",
      timezone: null,
      avatarImageId: NEW_AVATAR_ID,
      previousAvatarImageId: OLD_AVATAR_ID,
    }),
    deleteAvatarImage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe("updateAccountProfile", () => {
  it("rejects an avatar id that is missing or has the wrong kind", async () => {
    const missing = fakeProfileStore({
      findAvatarImage: vi.fn().mockResolvedValue(null),
    })
    await expect(
      updateAccountProfile(
        "usr_1",
        { avatarImageId: NEW_AVATAR_ID },
        { store: missing }
      )
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" })
    expect(missing.applyProfileUpdate).not.toHaveBeenCalled()

    const wrongKind = fakeProfileStore({
      findAvatarImage: vi.fn().mockResolvedValue({ kind: "logo-light" }),
    })
    await expect(
      updateAccountProfile(
        "usr_1",
        { avatarImageId: NEW_AVATAR_ID },
        { store: wrongKind }
      )
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" })
  })

  it("deletes the replaced avatar row after committing the patch", async () => {
    const store = fakeProfileStore()
    const now = new Date("2026-07-18T00:00:00Z")
    const profile = await updateAccountProfile(
      "usr_1",
      { avatarImageId: NEW_AVATAR_ID },
      { store, now: () => now }
    )
    expect(profile).toEqual({
      name: "Stephen",
      email: "admin@example.com",
      timezone: null,
      avatarImageId: NEW_AVATAR_ID,
    })
    expect(store.applyProfileUpdate).toHaveBeenCalledWith({
      userId: "usr_1",
      patch: { avatarImageId: NEW_AVATAR_ID },
      now,
    })
    expect(store.deleteAvatarImage).toHaveBeenCalledWith(OLD_AVATAR_ID)
  })

  it("keeps the avatar row when the patch does not touch the avatar", async () => {
    const store = fakeProfileStore({
      applyProfileUpdate: vi.fn().mockResolvedValue({
        name: "Renamed",
        email: "admin@example.com",
        timezone: null,
        avatarImageId: OLD_AVATAR_ID,
        previousAvatarImageId: OLD_AVATAR_ID,
      }),
    })
    await updateAccountProfile("usr_1", { name: "Renamed" }, { store })
    expect(store.findAvatarImage).not.toHaveBeenCalled()
    expect(store.deleteAvatarImage).not.toHaveBeenCalled()
  })

  it("deletes the old row when the avatar is cleared", async () => {
    const store = fakeProfileStore({
      applyProfileUpdate: vi.fn().mockResolvedValue({
        name: "Stephen",
        email: "admin@example.com",
        timezone: null,
        avatarImageId: null,
        previousAvatarImageId: OLD_AVATAR_ID,
      }),
    })
    await updateAccountProfile("usr_1", { avatarImageId: null }, { store })
    expect(store.findAvatarImage).not.toHaveBeenCalled()
    expect(store.deleteAvatarImage).toHaveBeenCalledWith(OLD_AVATAR_ID)
  })

  it("reports a missing account", async () => {
    const store = fakeProfileStore({
      applyProfileUpdate: vi.fn().mockResolvedValue(null),
    })
    await expect(
      updateAccountProfile("usr_1", { name: "Stephen" }, { store })
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" })
  })
})

describe("email change input validation", () => {
  it("requires all three fields and rejects extras", () => {
    expect(
      validateEmailChangeInput({
        email: "new@example.com",
        emailConfirm: "new@example.com",
        currentPassword: "pw",
      })
    ).toEqual({
      email: "new@example.com",
      emailConfirm: "new@example.com",
      currentPassword: "pw",
    })
    expect(() =>
      validateEmailChangeInput({
        email: "new@example.com",
        emailConfirm: "new@example.com",
      })
    ).toThrow(AccountServiceError)
    expect(() =>
      validateEmailChangeInput({
        email: "a@b.co",
        emailConfirm: "a@b.co",
        currentPassword: "pw",
        extra: true,
      })
    ).toThrow(AccountServiceError)
  })
})

function fakeStore(
  overrides: Partial<EmailChangeStore> = {}
): EmailChangeStore {
  return {
    findUser: vi.fn().mockResolvedValue({
      email: "old@example.com",
      passwordDigest: "digest",
    }),
    applyEmailChange: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

const deterministicDigest = (value: string) =>
  Buffer.from(value.padEnd(32, "#").slice(0, 32))

const allowedLimit = vi
  .fn()
  .mockResolvedValue({ allowed: true, remaining: 4, retryAfterSeconds: 1 })

describe("changeAccountEmail", () => {
  const base = {
    userId: "usr_1",
    currentSessionId: "ses_1",
    ip: "203.0.113.7",
    currentPassword: "correct horse",
  }
  const limitDeps = {
    enforceLimit: allowedLimit,
    digestKey: deterministicDigest,
  }

  it("rejects mismatched confirmation before touching the store", async () => {
    const store = fakeStore()
    await expect(
      changeAccountEmail(
        {
          ...base,
          email: "new@example.com",
          emailConfirm: "other@example.com",
        },
        { store, ...limitDeps }
      )
    ).rejects.toMatchObject({ code: "EMAIL_MISMATCH" })
    expect(store.findUser).not.toHaveBeenCalled()
  })

  it("rejects invalid addresses", async () => {
    await expect(
      changeAccountEmail(
        {
          ...base,
          email: "not-an-email",
          emailConfirm: "not-an-email",
        },
        { store: fakeStore(), ...limitDeps }
      )
    ).rejects.toMatchObject({ code: "INVALID_EMAIL" })
  })

  it("shares the login rate-limit buckets and blocks before verifying", async () => {
    const store = fakeStore()
    const verify = vi.fn()
    const enforceLimit = vi.fn().mockResolvedValue({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 90,
    })
    await expect(
      changeAccountEmail(
        { ...base, email: "new@example.com", emailConfirm: "new@example.com" },
        { store, verify, enforceLimit, digestKey: deterministicDigest }
      )
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 90 })
    expect(verify).not.toHaveBeenCalled()
    expect(store.applyEmailChange).not.toHaveBeenCalled()
    expect(enforceLimit).toHaveBeenCalledTimes(2)
    for (const [key, policy] of enforceLimit.mock.calls) {
      expect(String(key)).toMatch(/^login-(email|ip):[0-9a-f]+$/)
      expect(policy).toMatchObject({
        routeKey: "human-login",
        limit: 5,
        windowSeconds: 900,
      })
    }
  })

  it("rejects a wrong current password without applying anything", async () => {
    const store = fakeStore()
    await expect(
      changeAccountEmail(
        {
          ...base,
          email: "new@example.com",
          emailConfirm: "new@example.com",
        },
        { store, verify: async () => false, ...limitDeps }
      )
    ).rejects.toMatchObject({ code: "INVALID_PASSWORD" })
    expect(store.applyEmailChange).not.toHaveBeenCalled()
  })

  it("normalizes, verifies, and applies the change transactionally", async () => {
    const store = fakeStore()
    const now = new Date("2026-07-18T00:00:00Z")
    await expect(
      changeAccountEmail(
        {
          ...base,
          email: "  New@Example.COM ",
          emailConfirm: "new@example.com",
        },
        { store, verify: async () => true, now: () => now, ...limitDeps }
      )
    ).resolves.toEqual({ email: "new@example.com" })
    expect(store.applyEmailChange).toHaveBeenCalledWith({
      userId: "usr_1",
      currentSessionId: "ses_1",
      previousEmail: "old@example.com",
      email: "new@example.com",
      now,
    })
  })

  it("treats re-entering the current address as a no-op", async () => {
    const store = fakeStore()
    await expect(
      changeAccountEmail(
        {
          ...base,
          email: "old@example.com",
          emailConfirm: "old@example.com",
        },
        { store, verify: async () => true, ...limitDeps }
      )
    ).resolves.toEqual({ email: "old@example.com" })
    expect(store.applyEmailChange).not.toHaveBeenCalled()
  })
})

describe("password change input validation", () => {
  it("requires both password fields and rejects extras", () => {
    expect(
      validatePasswordChangeInput({
        currentPassword: "old",
        newPassword: "new",
      })
    ).toEqual({ currentPassword: "old", newPassword: "new" })
    expect(() =>
      validatePasswordChangeInput({ currentPassword: "old" })
    ).toThrow(AccountServiceError)
    expect(() =>
      validatePasswordChangeInput({
        currentPassword: "old",
        newPassword: "new",
        extra: 1,
      })
    ).toThrow(AccountServiceError)
    expect(() => validatePasswordChangeInput(null)).toThrow(AccountServiceError)
  })
})

function fakePasswordStore(
  overrides: Partial<PasswordChangeStore> = {}
): PasswordChangeStore {
  return {
    findUser: vi.fn().mockResolvedValue({
      email: "admin@example.com",
      passwordDigest: "digest",
    }),
    applyPasswordChange: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe("changeAccountPassword", () => {
  const base = {
    userId: "usr_1",
    currentSessionId: "ses_1",
    ip: "203.0.113.7",
    currentPassword: "correct horse battery",
  }

  it("rejects a policy-violating new password before touching the store", async () => {
    const store = fakePasswordStore()
    await expect(
      changeAccountPassword({ ...base, newPassword: "short" }, { store })
    ).rejects.toMatchObject({ code: "PASSWORD_POLICY" })
    expect(store.findUser).not.toHaveBeenCalled()
  })

  it("shares the login rate-limit buckets and blocks before verifying", async () => {
    const store = fakePasswordStore()
    const verify = vi.fn()
    const enforceLimit = vi.fn().mockResolvedValue({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 120,
    })
    await expect(
      changeAccountPassword(
        { ...base, newPassword: "a-long-enough-password" },
        { store, verify, enforceLimit, digestKey: deterministicDigest }
      )
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 120 })
    expect(verify).not.toHaveBeenCalled()
    expect(store.applyPasswordChange).not.toHaveBeenCalled()
    expect(enforceLimit).toHaveBeenCalledTimes(2)
    for (const [key, policy] of enforceLimit.mock.calls) {
      expect(String(key)).toMatch(/^login-(email|ip):[0-9a-f]+$/)
      expect(policy).toMatchObject({
        routeKey: "human-login",
        limit: 5,
        windowSeconds: 900,
      })
    }
  })

  it("rejects a wrong current password without applying anything", async () => {
    const store = fakePasswordStore()
    await expect(
      changeAccountPassword(
        { ...base, newPassword: "a-long-enough-password" },
        {
          store,
          verify: async () => false,
          enforceLimit: allowedLimit,
          digestKey: deterministicDigest,
        }
      )
    ).rejects.toMatchObject({ code: "INVALID_PASSWORD" })
    expect(store.applyPasswordChange).not.toHaveBeenCalled()
  })

  it("re-hashes and revokes the other sessions in the same store call", async () => {
    const store = fakePasswordStore()
    const now = new Date("2026-07-18T00:00:00Z")
    await expect(
      changeAccountPassword(
        { ...base, newPassword: "a-long-enough-password" },
        {
          store,
          verify: async () => true,
          hash: async (password) => `argon2id:${password}`,
          enforceLimit: allowedLimit,
          digestKey: deterministicDigest,
          now: () => now,
        }
      )
    ).resolves.toEqual({ changed: true })
    expect(store.applyPasswordChange).toHaveBeenCalledWith({
      userId: "usr_1",
      currentSessionId: "ses_1",
      passwordDigest: "argon2id:a-long-enough-password",
      now,
    })
  })

  it("reports a missing account", async () => {
    const store = fakePasswordStore({
      findUser: vi.fn().mockResolvedValue(null),
    })
    await expect(
      changeAccountPassword(
        { ...base, newPassword: "a-long-enough-password" },
        { store }
      )
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" })
  })
})

function fakeSessionStore(
  overrides: Partial<SessionRevocationStore> = {}
): SessionRevocationStore {
  return {
    revokeSession: vi.fn().mockResolvedValue(true),
    revokeOtherSessions: vi.fn().mockResolvedValue(2),
    ...overrides,
  }
}

describe("session revocation", () => {
  it("refuses to revoke the current session before touching the store", async () => {
    const store = fakeSessionStore()
    await expect(
      revokeAccountSession(
        { userId: "usr_1", sessionId: "ses_1", currentSessionId: "ses_1" },
        { store }
      )
    ).rejects.toMatchObject({ code: "CURRENT_SESSION" })
    expect(store.revokeSession).not.toHaveBeenCalled()
  })

  it("revokes another live session", async () => {
    const store = fakeSessionStore()
    const now = new Date("2026-07-18T00:00:00Z")
    await revokeAccountSession(
      { userId: "usr_1", sessionId: "ses_2", currentSessionId: "ses_1" },
      { store, now: () => now }
    )
    expect(store.revokeSession).toHaveBeenCalledWith({
      userId: "usr_1",
      sessionId: "ses_2",
      now,
    })
  })

  it("reports sessions that are gone or already signed out", async () => {
    const store = fakeSessionStore({
      revokeSession: vi.fn().mockResolvedValue(false),
    })
    await expect(
      revokeAccountSession(
        { userId: "usr_1", sessionId: "ses_2", currentSessionId: "ses_1" },
        { store }
      )
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" })
  })

  it("signs out every other session and reports the count", async () => {
    const store = fakeSessionStore()
    await expect(
      revokeOtherAccountSessions(
        { userId: "usr_1", currentSessionId: "ses_1" },
        { store }
      )
    ).resolves.toEqual({ revokedCount: 2 })
    expect(store.revokeOtherSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "usr_1",
        currentSessionId: "ses_1",
      })
    )
  })
})
