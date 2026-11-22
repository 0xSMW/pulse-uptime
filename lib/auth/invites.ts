import "server-only"

import { and, desc, sql as drizzleSql, eq, gt, isNull, max } from "drizzle-orm"
import { trackEvent } from "@/lib/analytics-server"
import { revokeUserMachineCredentials } from "@/lib/api/credential-revocation"
import { lockMachineCredentialChanges } from "@/lib/api/machine-credential-lock"
import type { Principal } from "@/lib/api/principal"
import {
  isUserRole,
  normalizeScopes,
  resolveScopeProfile,
  type UserRole,
} from "@/lib/api/scopes"
import {
  createBearerToken,
  digestBearerToken,
  INVITE_TOKEN_PREFIX,
} from "@/lib/api/tokens"
import { type DatabaseHandle, db } from "@/lib/db/client"
import {
  adminUsers,
  apiTokens,
  cliInstallations,
  cliSessions,
  humanSessions,
  onboardingProgress,
  userInvites,
} from "@/lib/db/schema"

import {
  createSessionToken,
  hashPassword,
  normalizeEmail,
  sessionExpiresAt,
  validatePassword,
} from "./credentials"

const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

export class TeamServiceError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "INVITE_INVALID"
      | "EMAIL_IN_USE"
      | "LAST_ADMIN"
      | "SELF_FORBIDDEN"
      | "ACTOR_DENIED"
      | "USER_NOT_FOUND",
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = "TeamServiceError"
  }
}

export interface TeamUser {
  id: string
  email: string
  name: string | null
  role: UserRole
  createdAt: Date
  lastSeenAt: Date | null
}

export interface TeamInvite {
  id: string
  role: UserRole
  createdByPrincipal: string
  createdAt: Date
  expiresAt: Date
}

function narrowRole(role: string): UserRole {
  // An unrecognized stored value narrows to viewer, never widens.
  return isUserRole(role) ? role : "viewer"
}

export async function listTeam(now = new Date()): Promise<{
  users: TeamUser[]
  invites: TeamInvite[]
}> {
  const [users, invites] = await Promise.all([
    db
      .select({
        id: adminUsers.id,
        email: adminUsers.email,
        name: adminUsers.name,
        role: adminUsers.role,
        createdAt: adminUsers.createdAt,
        lastSeenAt: max(humanSessions.lastSeenAt),
      })
      .from(adminUsers)
      .leftJoin(humanSessions, eq(humanSessions.userId, adminUsers.id))
      .groupBy(adminUsers.id)
      .orderBy(adminUsers.createdAt),
    db
      .select({
        id: userInvites.id,
        role: userInvites.role,
        createdByPrincipal: userInvites.createdByPrincipal,
        createdAt: userInvites.createdAt,
        expiresAt: userInvites.expiresAt,
      })
      .from(userInvites)
      .where(
        and(
          isNull(userInvites.acceptedAt),
          isNull(userInvites.revokedAt),
          gt(userInvites.expiresAt, now)
        )
      )
      .orderBy(desc(userInvites.createdAt)),
  ])
  return {
    users: users.map((user) => ({ ...user, role: narrowRole(user.role) })),
    invites: invites.map((invite) => ({
      ...invite,
      role: narrowRole(invite.role),
    })),
  }
}

export interface CreatedInvite {
  id: string
  role: UserRole
  /** One-time secret. Never persisted, never recoverable after this response. */
  token: string
  createdAt: Date
  expiresAt: Date
}

export function validateInviteRole(role: unknown): UserRole {
  if (typeof role !== "string" || !isUserRole(role)) {
    throw new TeamServiceError("INVALID_INPUT", "Role must be admin or viewer")
  }
  return role
}

export async function createUserInvite(
  input: {
    role: UserRole
    createdByPrincipal: string
    actor: Principal
    credential?: ReturnType<typeof createBearerToken>
  },
  now: Date,
  handle: DatabaseHandle
): Promise<CreatedInvite> {
  if (!("rollback" in handle)) {
    throw new Error("Invite creation requires a transaction")
  }
  await requireCurrentUserManager(handle, input.actor, now)
  if (input.createdByPrincipal !== `${input.actor.type}:${input.actor.id}`) {
    throw new TeamServiceError(
      "ACTOR_DENIED",
      "Administrator access is no longer active"
    )
  }
  const credential = input.credential ?? createBearerToken(INVITE_TOKEN_PREFIX)
  if (input.credential) {
    // Idempotent replay inside one atomic operation: a derived credential that
    // already exists means this exact create already ran.
    const [existing] = await handle
      .select({
        id: userInvites.id,
        role: userInvites.role,
        createdAt: userInvites.createdAt,
        expiresAt: userInvites.expiresAt,
      })
      .from(userInvites)
      .where(eq(userInvites.tokenDigest, credential.digest))
      .limit(1)
    if (existing) {
      return {
        ...existing,
        role: narrowRole(existing.role),
        token: credential.raw,
      }
    }
  }
  const invite = {
    id: crypto.randomUUID(),
    tokenDigest: credential.digest,
    role: input.role,
    createdByPrincipal: input.createdByPrincipal,
    issuedByHumanSessionId:
      input.actor.type === "human" ? input.actor.sessionId : null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + INVITE_LIFETIME_MS),
  }
  await handle.insert(userInvites).values(invite)
  trackEvent("Invite Created", { role: input.role })
  return {
    id: invite.id,
    role: input.role,
    token: credential.raw,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
  }
}

/** Revalidate the creator and pending link before reconstructing a replay secret. */
export async function requireReplayableUserInvite(
  inviteId: string,
  tokenDigest: Buffer,
  actor: Principal,
  now = new Date(),
  handle: DatabaseHandle = db
): Promise<void> {
  await handle.transaction(async (tx) => {
    await requireCurrentUserManager(tx, actor, now)
    const [invite] = await tx
      .select({ id: userInvites.id })
      .from(userInvites)
      .where(
        and(
          eq(userInvites.id, inviteId),
          eq(userInvites.tokenDigest, tokenDigest),
          eq(userInvites.createdByPrincipal, `${actor.type}:${actor.id}`),
          isNull(userInvites.acceptedAt),
          isNull(userInvites.revokedAt),
          gt(userInvites.expiresAt, now)
        )
      )
      .for("update")
      .limit(1)
    if (!invite) {
      throw new TeamServiceError("INVITE_INVALID", "Invite is no longer active")
    }
  })
}

export async function revokeUserInvite(
  inviteId: string,
  now = new Date(),
  handle: DatabaseHandle = db
): Promise<{ id: string }> {
  const [revoked] = await handle
    .update(userInvites)
    .set({ revokedAt: now })
    .where(
      and(
        eq(userInvites.id, inviteId),
        isNull(userInvites.acceptedAt),
        isNull(userInvites.revokedAt)
      )
    )
    .returning({ id: userInvites.id })
  if (!revoked) {
    throw new TeamServiceError(
      "INVITE_INVALID",
      "This invite is no longer pending"
    )
  }
  return revoked
}

/** Pending-invite lookup for the join page. Returns null instead of throwing. */
export async function findPendingInvite(
  rawToken: string,
  now = new Date()
): Promise<{ id: string; role: UserRole; expiresAt: Date } | null> {
  if (!rawToken || rawToken.length > 128) {
    return null
  }
  const [invite] = await db
    .select({
      id: userInvites.id,
      role: userInvites.role,
      expiresAt: userInvites.expiresAt,
    })
    .from(userInvites)
    .where(
      and(
        eq(userInvites.tokenDigest, digestBearerToken(rawToken)),
        isNull(userInvites.acceptedAt),
        isNull(userInvites.revokedAt),
        gt(userInvites.expiresAt, now)
      )
    )
    .limit(1)
  return invite ? { ...invite, role: narrowRole(invite.role) } : null
}

export interface AcceptInviteInput {
  digest: Buffer
  userId: string
  email: string
  name: string | null
  passwordDigest: string
  sessionId: string
  sessionDigest: Buffer
  sessionExpiresAt: Date
  userAgent: string | null
  ipAddress: string | null
  now: Date
}

export interface AcceptInviteStore {
  hasPendingInvite: (digest: Buffer, now: Date) => Promise<boolean>
  /** Claims the invite and creates user plus session in one transaction. */
  accept: (input: AcceptInviteInput) => Promise<"accepted" | "invite-gone">
}

export async function acceptUserInvite(
  input: {
    token: string
    email: string
    password: string
    passwordConfirmation: string
    name?: string | null
    userAgent?: string | null
    ipAddress?: string | null
  },
  dependencies: {
    store?: AcceptInviteStore
    hash?: typeof hashPassword
    now?: () => Date
  } = {}
): Promise<{ userId: string; sessionToken: string; expiresAt: Date }> {
  const now = dependencies.now?.() ?? new Date()
  const email = normalizeEmail(input.email)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TeamServiceError("INVALID_INPUT", "Enter a valid email address")
  }
  const passwordError = validatePassword(input.password)
  if (passwordError) {
    throw new TeamServiceError("INVALID_INPUT", passwordError)
  }
  if (input.password !== input.passwordConfirmation) {
    throw new TeamServiceError("INVALID_INPUT", "Passwords do not match")
  }
  const name = normalizeOptionalName(input.name)
  if (!input.token || input.token.length > 128) {
    throw new TeamServiceError("INVITE_INVALID", INVITE_GONE_MESSAGE)
  }

  const store = dependencies.store ?? databaseAcceptInviteStore
  const digest = digestBearerToken(input.token)
  // The atomic claim inside store.accept is authoritative. This read only
  // gates the Argon2 cost so an invalid link cannot buy expensive hashing.
  if (!(await store.hasPendingInvite(digest, now))) {
    throw new TeamServiceError("INVITE_INVALID", INVITE_GONE_MESSAGE)
  }

  const passwordDigest = await (dependencies.hash ?? hashPassword)(
    input.password
  )
  const session = createSessionToken()
  const userId = crypto.randomUUID()

  let outcome: "accepted" | "invite-gone"
  try {
    outcome = await store.accept({
      digest,
      userId,
      email,
      name,
      passwordDigest,
      sessionId: crypto.randomUUID(),
      sessionDigest: session.digest,
      sessionExpiresAt: sessionExpiresAt(now),
      userAgent: input.userAgent?.trim().slice(0, 512) || null,
      ipAddress: input.ipAddress ?? null,
      now,
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      // biome-ignore lint/style/useErrorCause: cause is threaded through the error options arg, biome only detects the native second-argument position
      throw new TeamServiceError(
        "EMAIL_IN_USE",
        "An account with this email already exists",
        { cause: error }
      )
    }
    throw error
  }
  if (outcome === "invite-gone") {
    throw new TeamServiceError("INVITE_INVALID", INVITE_GONE_MESSAGE)
  }
  return { userId, sessionToken: session.raw, expiresAt: sessionExpiresAt(now) }
}

const INVITE_GONE_MESSAGE = "This invite link is invalid or has expired"

const databaseAcceptInviteStore: AcceptInviteStore = {
  async hasPendingInvite(digest, now) {
    const [invite] = await db
      .select({ id: userInvites.id })
      .from(userInvites)
      .where(
        and(
          eq(userInvites.tokenDigest, digest),
          isNull(userInvites.acceptedAt),
          isNull(userInvites.revokedAt),
          gt(userInvites.expiresAt, now)
        )
      )
      .limit(1)
    return Boolean(invite)
  },
  async accept(input) {
    return db.transaction(async (tx) => {
      // Single-use enforcement: the accepted_at flip is the atomic claim, so
      // two concurrent submissions of one link can never both create a user.
      // A failure later in the transaction (duplicate email) rolls the claim
      // back and the link stays usable.
      const [claimed] = await tx
        .update(userInvites)
        .set({ acceptedAt: input.now, acceptedByUserId: input.userId })
        .where(
          and(
            eq(userInvites.tokenDigest, input.digest),
            isNull(userInvites.acceptedAt),
            isNull(userInvites.revokedAt),
            gt(userInvites.expiresAt, input.now)
          )
        )
        .returning({ role: userInvites.role })
      if (!claimed) {
        return "invite-gone"
      }
      await tx.insert(adminUsers).values({
        id: input.userId,
        email: input.email,
        name: input.name,
        passwordDigest: input.passwordDigest,
        role: narrowRole(claimed.role),
        createdAt: input.now,
        updatedAt: input.now,
        passwordChangedAt: input.now,
        // Invited users land on the live dashboard. Onboarding is the
        // first-run install flow, not a per-user tour.
        onboardingCompletedAt: input.now,
      })
      await tx.insert(humanSessions).values({
        id: input.sessionId,
        userId: input.userId,
        tokenDigest: input.sessionDigest,
        userAgent: input.userAgent,
        ipAddress: input.ipAddress,
        createdAt: input.now,
        expiresAt: input.sessionExpiresAt,
      })
      return "accepted"
    })
  },
}

export interface RoleChangeResult {
  id: string
  email: string
  role: UserRole
  revokedCliSessions: number
  revokedApiTokens: number
}

/**
 * Both role changes and removals serialize on one advisory lock so concurrent
 * demotions of the final two admins cannot each observe the other and leave
 * the install with no admin.
 */
const TEAM_LOCK_SQL = drizzleSql`select pg_advisory_xact_lock(hashtext('pulse:team-roles'))`

/** Serialize team writes with demotion, session revocation, and credential revocation. */
async function requireCurrentUserManager(
  tx: TeamTransaction,
  actor: Principal,
  now: Date
): Promise<string> {
  await tx.execute(TEAM_LOCK_SQL)
  await lockMachineCredentialChanges(tx)

  if (actor.type === "human") {
    const [current] = await tx
      .select({ userId: adminUsers.id })
      .from(humanSessions)
      .innerJoin(adminUsers, eq(adminUsers.id, humanSessions.userId))
      .where(
        and(
          eq(humanSessions.id, actor.sessionId),
          eq(humanSessions.userId, actor.id),
          isNull(humanSessions.revokedAt),
          gt(humanSessions.expiresAt, now),
          eq(adminUsers.role, "admin")
        )
      )
      .for("update")
      .limit(1)
    if (current) {
      return current.userId
    }
  } else if (actor.type === "api_token") {
    const [current] = await tx
      .select({ userId: adminUsers.id, scopes: apiTokens.scopes })
      .from(apiTokens)
      .innerJoin(adminUsers, eq(adminUsers.id, apiTokens.credentialOwnerUserId))
      .where(
        and(
          eq(apiTokens.id, actor.id),
          isNull(apiTokens.revokedAt),
          gt(apiTokens.expiresAt, now),
          eq(apiTokens.credentialEpoch, adminUsers.credentialEpoch),
          eq(adminUsers.role, "admin")
        )
      )
      .for("update")
      .limit(1)
    if (current?.scopes.includes("users:manage")) {
      return current.userId
    }
  } else {
    const [current] = await tx
      .select({
        userId: adminUsers.id,
        scopes: cliSessions.scopes,
        scopeProfile: cliSessions.scopeProfile,
      })
      .from(cliSessions)
      .innerJoin(
        cliInstallations,
        eq(cliInstallations.id, cliSessions.installationId)
      )
      .innerJoin(adminUsers, eq(adminUsers.id, cliInstallations.userId))
      .where(
        and(
          eq(cliSessions.id, actor.id),
          isNull(cliSessions.revokedAt),
          gt(cliSessions.expiresAt, now),
          isNull(cliInstallations.revokedAt),
          eq(cliInstallations.credentialEpoch, adminUsers.credentialEpoch),
          eq(adminUsers.role, "admin")
        )
      )
      .for("update")
      .limit(1)
    const scopes = current
      ? (resolveScopeProfile(current.scopeProfile) ??
        normalizeScopes(current.scopes))
      : []
    if (current && scopes.includes("users:manage")) {
      return current.userId
    }
  }
  throw new TeamServiceError(
    "ACTOR_DENIED",
    "Administrator access is no longer active"
  )
}

export async function changeUserRole(
  input: { userId: string; role: unknown; actor: Principal },
  now = new Date(),
  handle: DatabaseHandle = db
): Promise<RoleChangeResult> {
  if (typeof input.role !== "string" || !isUserRole(input.role)) {
    throw new TeamServiceError("INVALID_INPUT", "Role must be admin or viewer")
  }
  const role = input.role
  return handle.transaction(async (tx) => {
    await requireCurrentUserManager(tx, input.actor, now)
    const [target] = await tx
      .select({
        id: adminUsers.id,
        email: adminUsers.email,
        role: adminUsers.role,
      })
      .from(adminUsers)
      .where(eq(adminUsers.id, input.userId))
      .limit(1)
    if (!target) {
      throw new TeamServiceError("USER_NOT_FOUND", "No such user")
    }
    if (narrowRole(target.role) === role) {
      return {
        id: target.id,
        email: target.email,
        role,
        revokedCliSessions: 0,
        revokedApiTokens: 0,
      }
    }
    if (narrowRole(target.role) === "admin" && role === "viewer") {
      await assertAnotherAdminExists(tx, target.id)
    }
    await tx
      .update(adminUsers)
      .set({ role, updatedAt: now })
      .where(eq(adminUsers.id, target.id))
    // Demotion narrows web sessions immediately (scopes resolve from the row
    // per request), but CLI sessions carry the administrator profile and API
    // tokens carry minted scopes, so both are revoked outright.
    const revoked =
      role === "viewer"
        ? await revokeIssuedCredentials(tx, target.id, target.email, now)
        : { revokedCliSessions: 0, revokedApiTokens: 0 }
    return { id: target.id, email: target.email, role, ...revoked }
  })
}

export async function removeUser(
  input: { userId: string; actorUserId: string; actor: Principal },
  now = new Date()
): Promise<{ id: string; email: string }> {
  if (input.userId === input.actorUserId) {
    throw new TeamServiceError(
      "SELF_FORBIDDEN",
      "You cannot remove your own account"
    )
  }
  return db.transaction(async (tx) => {
    const currentActorUserId = await requireCurrentUserManager(
      tx,
      input.actor,
      now
    )
    if (
      input.actor.type === "api_token" ||
      currentActorUserId !== input.actorUserId
    ) {
      throw new TeamServiceError(
        "ACTOR_DENIED",
        "Administrator access is no longer active"
      )
    }
    const [target] = await tx
      .select({
        id: adminUsers.id,
        email: adminUsers.email,
        role: adminUsers.role,
      })
      .from(adminUsers)
      .where(eq(adminUsers.id, input.userId))
      .limit(1)
    if (!target) {
      throw new TeamServiceError("USER_NOT_FOUND", "No such user")
    }
    if (narrowRole(target.role) === "admin") {
      await assertAnotherAdminExists(tx, target.id)
    }
    await revokeIssuedCredentials(tx, target.id, target.email, now)
    // Invite rows the user accepted keep only a dangling uuid by design, and
    // rows they created reference a text principal key (pending ones are
    // revoked above), so nothing blocks the hard delete.
    await tx.delete(humanSessions).where(eq(humanSessions.userId, target.id))
    await tx
      .delete(onboardingProgress)
      .where(eq(onboardingProgress.userId, target.id))
    await tx.delete(adminUsers).where(eq(adminUsers.id, target.id))
    return { id: target.id, email: target.email }
  })
}

type TeamTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function assertAnotherAdminExists(
  tx: TeamTransaction,
  excludingUserId: string
) {
  const [other] = await tx
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(
      and(
        eq(adminUsers.role, "admin"),
        drizzleSql`${adminUsers.id} <> ${excludingUserId}`
      )
    )
    .limit(1)
  if (!other) {
    throw new TeamServiceError(
      "LAST_ADMIN",
      "At least one admin must remain. Promote someone else first"
    )
  }
}

/**
 * Removing a person, or narrowing them to viewer, revokes everything they
 * hold: CLI sessions and installations, all descendant API tokens, and pending
 * invites created by any of those principals.
 */
async function revokeIssuedCredentials(
  tx: TeamTransaction,
  userId: string,
  email: string,
  now: Date
): Promise<{ revokedCliSessions: number; revokedApiTokens: number }> {
  return revokeUserMachineCredentials(tx, {
    userId,
    userEmail: email,
    now,
  })
}

function normalizeOptionalName(
  value: string | null | undefined
): string | null {
  if (value === null || value === undefined) {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  if (trimmed.length > 120) {
    throw new TeamServiceError(
      "INVALID_INPUT",
      "Name must contain 1 to 120 characters"
    )
  }
  return trimmed
}

/** Postgres unique_violation, walking the cause chain postgres.js may add. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error
  const seen = new Set<unknown>()
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current)
    if ((current as { code?: unknown }).code === "23505") {
      return true
    }
    current = (current as { cause?: unknown }).cause
  }
  return false
}
