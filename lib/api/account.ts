import "server-only"

import { and, eq, isNull, ne, sql } from "drizzle-orm"

import {
  enforceRateLimit,
  type RateLimitPolicy,
  type RateLimitResult,
} from "@/lib/api/rate-limit"
import { digestBearerToken } from "@/lib/api/tokens"
import {
  hashPassword,
  normalizeEmail,
  validatePassword,
  verifyPassword,
} from "@/lib/auth/credentials"
import { LOGIN_RATE_LIMIT_POLICY, loginRateLimitKey } from "@/lib/auth/service"
import { db } from "@/lib/db/client"
import {
  adminUsers,
  cliInstallations,
  cliSessions,
  humanSessions,
  images,
} from "@/lib/db/schema"
import { isUuid } from "@/lib/ids/uuid"
import { isValidIanaTimeZone } from "@/lib/time/iana"

export interface AccountProfile {
  name: string | null
  email: string
  timezone: string | null
  avatarImageId: string | null
}

export class AccountServiceError extends Error {
  constructor(
    readonly code:
      | "INVALID_PROFILE"
      | "INVALID_EMAIL"
      | "EMAIL_MISMATCH"
      | "INVALID_PASSWORD"
      | "PASSWORD_POLICY"
      | "RATE_LIMITED"
      | "SESSION_NOT_FOUND"
      | "CURRENT_SESSION"
      | "IMAGE_NOT_FOUND"
      | "ACCOUNT_NOT_FOUND"
      | "ACCOUNT_CHANGED",
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message)
    this.name = "AccountServiceError"
  }
}

/** Outcome of a compare-and-set account mutation under concurrency. */
export type AccountCasResult = "applied" | "conflict"

export interface ProfilePatch {
  name?: string
  timezone?: string | null
  avatarImageId?: string | null
}

export function validateProfilePatch(input: unknown): ProfilePatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AccountServiceError(
      "INVALID_PROFILE",
      "Profile details are required"
    )
  }
  const value = input as Record<string, unknown>
  const allowedKeys = new Set(["name", "timezone", "avatarImageId"])
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new AccountServiceError(
      "INVALID_PROFILE",
      "Profile details contain unsupported fields"
    )
  }
  const patch: ProfilePatch = {}
  if ("name" in value) {
    if (
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.trim().length > 120
    ) {
      throw new AccountServiceError(
        "INVALID_PROFILE",
        "Name must contain 1 to 120 characters"
      )
    }
    patch.name = value.name.trim()
  }
  if ("timezone" in value) {
    if (value.timezone === null) {
      patch.timezone = null
    } else if (
      typeof value.timezone === "string" &&
      value.timezone !== "system" &&
      isValidIanaTimeZone(value.timezone)
    ) {
      patch.timezone = value.timezone
    } else {
      throw new AccountServiceError(
        "INVALID_PROFILE",
        "Time zone must be a valid IANA zone name or null"
      )
    }
  }
  if ("avatarImageId" in value) {
    if (value.avatarImageId === null) {
      patch.avatarImageId = null
    } else if (
      typeof value.avatarImageId === "string" &&
      isUuid(value.avatarImageId)
    ) {
      patch.avatarImageId = value.avatarImageId
    } else {
      throw new AccountServiceError(
        "INVALID_PROFILE",
        "Avatar image ID must be an image UUID or null"
      )
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new AccountServiceError(
      "INVALID_PROFILE",
      "Provide at least one field to update"
    )
  }
  return patch
}

const profileSelection = {
  name: adminUsers.name,
  email: adminUsers.email,
  timezone: adminUsers.timezone,
  avatarImageId: adminUsers.avatarImageId,
}

export async function findAccountProfile(
  userId: string
): Promise<AccountProfile | null> {
  const [row] = await db
    .select(profileSelection)
    .from(adminUsers)
    .where(eq(adminUsers.id, userId))
    .limit(1)
  return row ?? null
}

export interface ProfileUpdateStore {
  findAvatarImage: (imageId: string) => Promise<{ kind: string } | null>
  applyProfileUpdate: (input: {
    userId: string
    patch: ProfilePatch
    now: Date
  }) => Promise<
    (AccountProfile & { previousAvatarImageId: string | null }) | null
  >
  deleteAvatarImage: (imageId: string) => Promise<void>
}

export interface ProfileUpdateDependencies {
  store?: ProfileUpdateStore
  now?: () => Date
}

/**
 * Updates the administrator profile. An avatarImageId must reference an
 * uploaded kind='avatar' image. The replaced avatar row is deleted afterwards
 * (a failed deletion leaves an orphan for the maintenance sweep).
 */
export async function updateAccountProfile(
  userId: string,
  patch: ProfilePatch,
  dependencies: ProfileUpdateDependencies = {}
): Promise<AccountProfile> {
  const store = dependencies.store ?? databaseProfileUpdateStore
  if (patch.avatarImageId) {
    const image = await store.findAvatarImage(patch.avatarImageId)
    if (image?.kind !== "avatar") {
      throw new AccountServiceError(
        "IMAGE_NOT_FOUND",
        "Upload the avatar image first, then attach it"
      )
    }
  }
  const result = await store.applyProfileUpdate({
    userId,
    patch,
    now: dependencies.now?.() ?? new Date(),
  })
  if (!result) {
    throw new AccountServiceError(
      "ACCOUNT_NOT_FOUND",
      "The account no longer exists"
    )
  }
  const { previousAvatarImageId, ...profile } = result
  if (
    "avatarImageId" in patch &&
    previousAvatarImageId &&
    previousAvatarImageId !== patch.avatarImageId
  ) {
    await store.deleteAvatarImage(previousAvatarImageId).catch(() => undefined)
  }
  return profile
}

const databaseProfileUpdateStore: ProfileUpdateStore = {
  async findAvatarImage(imageId) {
    const [row] = await db
      .select({ kind: images.kind })
      .from(images)
      .where(eq(images.id, imageId))
      .limit(1)
    return row ?? null
  },
  async applyProfileUpdate({ userId, patch, now }) {
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select({ avatarImageId: adminUsers.avatarImageId })
        .from(adminUsers)
        .where(eq(adminUsers.id, userId))
        .limit(1)
      if (!current) {
        return null
      }
      const [row] = await tx
        .update(adminUsers)
        .set({ ...patch, updatedAt: now })
        .where(eq(adminUsers.id, userId))
        .returning(profileSelection)
      return row
        ? { ...row, previousAvatarImageId: current.avatarImageId }
        : null
    })
  },
  async deleteAvatarImage(imageId) {
    await db
      .delete(images)
      .where(and(eq(images.id, imageId), eq(images.kind, "avatar")))
  },
}

export interface EmailChangeInput {
  email: string
  emailConfirm: string
  currentPassword: string
}

export function validateEmailChangeInput(input: unknown): EmailChangeInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AccountServiceError(
      "INVALID_EMAIL",
      "Email change details are required"
    )
  }
  const value = input as Record<string, unknown>
  const allowedKeys = new Set(["email", "emailConfirm", "currentPassword"])
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new AccountServiceError(
      "INVALID_EMAIL",
      "Email change details contain unsupported fields"
    )
  }
  if (
    typeof value.email !== "string" ||
    typeof value.emailConfirm !== "string" ||
    typeof value.currentPassword !== "string"
  ) {
    throw new AccountServiceError(
      "INVALID_EMAIL",
      "Email, confirmation, and current password are required"
    )
  }
  return {
    email: value.email,
    emailConfirm: value.emailConfirm,
    currentPassword: value.currentPassword,
  }
}

export interface EmailChangeStore {
  findUser: (
    userId: string
  ) => Promise<{ email: string; passwordDigest: string } | null>
  applyEmailChange: (input: {
    userId: string
    currentSessionId: string
    previousEmail: string
    email: string
    now: Date
  }) => Promise<AccountCasResult>
}

export interface EmailChangeDependencies {
  store?: EmailChangeStore
  verify?: typeof verifyPassword
  enforceLimit?: (
    principalKey: string,
    policy: RateLimitPolicy,
    now: Date
  ) => Promise<RateLimitResult>
  digestKey?: (value: string) => Buffer
  now?: () => Date
}

/**
 * Changes the sole login identifier. Shares the login rate-limit buckets so
 * current-password guesses count against the same 5-per-15-minutes budget as
 * sign-in attempts (mirroring changeAccountPassword). Compare-and-sets against
 * the verified previous email so concurrent changes have a single winner.
 * Revokes every *other* human session and rewrites denormalized CLI email
 * copies in the same transaction. Machine credentials are not revoked.
 */
export async function changeAccountEmail(
  input: EmailChangeInput & {
    userId: string
    currentSessionId: string
    ip: string
  },
  dependencies: EmailChangeDependencies = {}
): Promise<{ email: string }> {
  const email = normalizeEmail(input.email)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AccountServiceError(
      "INVALID_EMAIL",
      "Enter a valid email address"
    )
  }
  if (normalizeEmail(input.emailConfirm) !== email) {
    throw new AccountServiceError(
      "EMAIL_MISMATCH",
      "Email addresses do not match"
    )
  }

  const store = dependencies.store ?? databaseEmailChangeStore
  const user = await store.findUser(input.userId)
  if (!user) {
    throw new AccountServiceError(
      "ACCOUNT_NOT_FOUND",
      "The account no longer exists"
    )
  }

  const now = dependencies.now?.() ?? new Date()
  const digest = dependencies.digestKey ?? digestBearerToken
  const limiter = dependencies.enforceLimit ?? enforceRateLimit
  const limits = await Promise.all(
    [
      loginRateLimitKey("email", user.email, digest),
      loginRateLimitKey("ip", input.ip, digest),
    ].map((key) => limiter(key, LOGIN_RATE_LIMIT_POLICY, now))
  )
  const blocked = limits.filter((result) => !result.allowed)
  if (blocked.length > 0) {
    throw new AccountServiceError(
      "RATE_LIMITED",
      "Too many attempts. Try again later.",
      Math.max(...blocked.map((result) => result.retryAfterSeconds))
    )
  }

  const verify = dependencies.verify ?? verifyPassword
  if (!(await verify(user.passwordDigest, input.currentPassword))) {
    throw new AccountServiceError(
      "INVALID_PASSWORD",
      "Current password is incorrect"
    )
  }

  if (email !== user.email) {
    const cas = await store.applyEmailChange({
      userId: input.userId,
      currentSessionId: input.currentSessionId,
      previousEmail: user.email,
      email,
      now,
    })
    if (cas === "conflict") {
      throw new AccountServiceError(
        "ACCOUNT_CHANGED",
        "Account details changed. Refresh and try again."
      )
    }
  }
  return { email }
}

export interface PasswordChangeInput {
  currentPassword: string
  newPassword: string
}

export function validatePasswordChangeInput(
  input: unknown
): PasswordChangeInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AccountServiceError(
      "INVALID_PROFILE",
      "Password change details are required"
    )
  }
  const value = input as Record<string, unknown>
  const allowedKeys = new Set(["currentPassword", "newPassword"])
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new AccountServiceError(
      "INVALID_PROFILE",
      "Password change details contain unsupported fields"
    )
  }
  if (
    typeof value.currentPassword !== "string" ||
    typeof value.newPassword !== "string"
  ) {
    throw new AccountServiceError(
      "INVALID_PROFILE",
      "Current and new passwords are required"
    )
  }
  return {
    currentPassword: value.currentPassword,
    newPassword: value.newPassword,
  }
}

export interface PasswordChangeStore {
  findUser: (
    userId: string
  ) => Promise<{ email: string; passwordDigest: string } | null>
  applyPasswordChange: (input: {
    userId: string
    expectedPasswordDigest: string
    passwordDigest: string
    now: Date
  }) => Promise<AccountCasResult>
}

export interface PasswordChangeDependencies {
  store?: PasswordChangeStore
  verify?: typeof verifyPassword
  hash?: typeof hashPassword
  enforceLimit?: (
    principalKey: string,
    policy: RateLimitPolicy,
    now: Date
  ) => Promise<RateLimitResult>
  digestKey?: (value: string) => Buffer
  now?: () => Date
}

/**
 * Changes the administrator password. Shares the login rate-limit buckets so
 * current-password guesses count against the same 5-per-15-minutes budget as
 * sign-in attempts, then re-hashes with Argon2id, stamps passwordChangedAt,
 * and revokes every unrevoked human session (including the current one) in the
 * same transaction. The update compare-and-sets against the verified digest so
 * concurrent rotations have a single winner.
 */
export async function changeAccountPassword(
  input: PasswordChangeInput & {
    userId: string
    currentSessionId: string
    ip: string
  },
  dependencies: PasswordChangeDependencies = {}
): Promise<{ changed: true }> {
  const policyError = validatePassword(input.newPassword)
  if (policyError) {
    throw new AccountServiceError("PASSWORD_POLICY", policyError)
  }

  const store = dependencies.store ?? databasePasswordChangeStore
  const user = await store.findUser(input.userId)
  if (!user) {
    throw new AccountServiceError(
      "ACCOUNT_NOT_FOUND",
      "The account no longer exists"
    )
  }

  const now = dependencies.now?.() ?? new Date()
  const digest = dependencies.digestKey ?? digestBearerToken
  const limiter = dependencies.enforceLimit ?? enforceRateLimit
  const limits = await Promise.all(
    [
      loginRateLimitKey("email", user.email, digest),
      loginRateLimitKey("ip", input.ip, digest),
    ].map((key) => limiter(key, LOGIN_RATE_LIMIT_POLICY, now))
  )
  const blocked = limits.filter((result) => !result.allowed)
  if (blocked.length > 0) {
    throw new AccountServiceError(
      "RATE_LIMITED",
      "Too many attempts. Try again later.",
      Math.max(...blocked.map((result) => result.retryAfterSeconds))
    )
  }

  const verify = dependencies.verify ?? verifyPassword
  if (!(await verify(user.passwordDigest, input.currentPassword))) {
    throw new AccountServiceError(
      "INVALID_PASSWORD",
      "Current password is incorrect"
    )
  }

  const passwordDigest = await (dependencies.hash ?? hashPassword)(
    input.newPassword
  )
  const cas = await store.applyPasswordChange({
    userId: input.userId,
    expectedPasswordDigest: user.passwordDigest,
    passwordDigest,
    now,
  })
  if (cas === "conflict") {
    throw new AccountServiceError(
      "ACCOUNT_CHANGED",
      "Account details changed. Refresh and try again."
    )
  }
  return { changed: true }
}

const databasePasswordChangeStore: PasswordChangeStore = {
  async findUser(userId) {
    const [row] = await db
      .select({
        email: adminUsers.email,
        passwordDigest: adminUsers.passwordDigest,
      })
      .from(adminUsers)
      .where(eq(adminUsers.id, userId))
      .limit(1)
    return row ?? null
  },
  async applyPasswordChange({
    userId,
    expectedPasswordDigest,
    passwordDigest,
    now,
  }) {
    return db.transaction(async (tx) => {
      const updated = await tx
        .update(adminUsers)
        .set({ passwordDigest, passwordChangedAt: now, updatedAt: now })
        .where(
          and(
            eq(adminUsers.id, userId),
            eq(adminUsers.passwordDigest, expectedPasswordDigest)
          )
        )
        .returning({ id: adminUsers.id })
      if (updated.length === 0) {
        return "conflict"
      }
      await tx
        .update(humanSessions)
        .set({ revokedAt: now })
        .where(
          and(eq(humanSessions.userId, userId), isNull(humanSessions.revokedAt))
        )
      return "applied"
    })
  },
}

export interface SessionRevocationStore {
  revokeSession: (input: {
    userId: string
    sessionId: string
    now: Date
  }) => Promise<boolean>
  revokeOtherSessions: (input: {
    userId: string
    currentSessionId: string
    now: Date
  }) => Promise<number>
}

export interface SessionRevocationDependencies {
  store?: SessionRevocationStore
  now?: () => Date
}

/** Revokes one of the administrator's other sessions. The current one is refused. */
export async function revokeAccountSession(
  input: { userId: string; sessionId: string; currentSessionId: string },
  dependencies: SessionRevocationDependencies = {}
): Promise<void> {
  if (input.sessionId === input.currentSessionId) {
    throw new AccountServiceError(
      "CURRENT_SESSION",
      "You cannot revoke the session you are currently using"
    )
  }
  const store = dependencies.store ?? databaseSessionRevocationStore
  const revoked = await store.revokeSession({
    userId: input.userId,
    sessionId: input.sessionId,
    now: dependencies.now?.() ?? new Date(),
  })
  if (!revoked) {
    throw new AccountServiceError(
      "SESSION_NOT_FOUND",
      "The session was not found or is already signed out"
    )
  }
}

/** Signs out every human session except the current one. */
export async function revokeOtherAccountSessions(
  input: { userId: string; currentSessionId: string },
  dependencies: SessionRevocationDependencies = {}
): Promise<{ revokedCount: number }> {
  const store = dependencies.store ?? databaseSessionRevocationStore
  const revokedCount = await store.revokeOtherSessions({
    userId: input.userId,
    currentSessionId: input.currentSessionId,
    now: dependencies.now?.() ?? new Date(),
  })
  return { revokedCount }
}

const databaseSessionRevocationStore: SessionRevocationStore = {
  async revokeSession({ userId, sessionId, now }) {
    const rows = await db
      .update(humanSessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(humanSessions.id, sessionId),
          eq(humanSessions.userId, userId),
          isNull(humanSessions.revokedAt)
        )
      )
      .returning({ id: humanSessions.id })
    return rows.length > 0
  },
  async revokeOtherSessions({ userId, currentSessionId, now }) {
    const rows = await db
      .update(humanSessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(humanSessions.userId, userId),
          ne(humanSessions.id, currentSessionId),
          isNull(humanSessions.revokedAt)
        )
      )
      .returning({ id: humanSessions.id })
    return rows.length
  },
}

const databaseEmailChangeStore: EmailChangeStore = {
  async findUser(userId) {
    const [row] = await db
      .select({
        email: adminUsers.email,
        passwordDigest: adminUsers.passwordDigest,
      })
      .from(adminUsers)
      .where(eq(adminUsers.id, userId))
      .limit(1)
    return row ?? null
  },
  async applyEmailChange({
    userId,
    currentSessionId,
    previousEmail,
    email,
    now,
  }) {
    return db.transaction(async (tx) => {
      // Team removals and demotions revoke CLI credentials by email under this
      // lock. Renaming the email must serialize with them or a rename that
      // commits mid-removal strands live CLI sessions under the new address.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('pulse:team-roles'))`
      )
      const updated = await tx
        .update(adminUsers)
        .set({ email, updatedAt: now })
        .where(
          and(eq(adminUsers.id, userId), eq(adminUsers.email, previousEmail))
        )
        .returning({ id: adminUsers.id })
      if (updated.length === 0) {
        return "conflict"
      }
      await tx
        .update(humanSessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(humanSessions.userId, userId),
            ne(humanSessions.id, currentSessionId),
            isNull(humanSessions.revokedAt)
          )
        )
      await tx
        .update(cliSessions)
        .set({ userEmail: email })
        .where(eq(cliSessions.userEmail, previousEmail))
      await tx
        .update(cliInstallations)
        .set({ userEmail: email })
        .where(eq(cliInstallations.userEmail, previousEmail))
      return "applied"
    })
  },
}
