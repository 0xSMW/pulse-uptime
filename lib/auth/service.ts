import "server-only"

import { and, sql as drizzleSql, eq, gt, isNull, lt, or } from "drizzle-orm"
import { after } from "next/server"
import {
  enforceRateLimit,
  type RateLimitPolicy,
  type RateLimitResult,
} from "@/lib/api/rate-limit"
import { digestBearerToken } from "@/lib/api/tokens"
import { db } from "@/lib/db/client"
import { adminUsers, humanSessions, onboardingProgress } from "@/lib/db/schema"
import { clientIpFromHeaders, firstForwardedIp } from "@/lib/net/client-ip"
import { verifyBootstrapToken } from "@/lib/onboarding/bootstrap"
import type { ReadinessReport } from "@/lib/readiness/types"

import {
  createSessionToken,
  hashPassword,
  LOGIN_DUMMY_PASSWORD_DIGEST,
  normalizeEmail,
  sessionExpiresAt,
  validatePassword,
  verifyPassword,
} from "./credentials"

export interface HumanSession {
  sessionId: string
  userId: string
  email: string
  timezone: string | null
  expiresAt: Date
  onboardingCompletedAt: Date | null
}

export class AuthServiceError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "NOT_READY"
      | "ADMIN_EXISTS"
      | "BOOTSTRAP_REQUIRED"
      | "INVALID_LOGIN"
      | "RATE_LIMITED",
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message)
    this.name = "AuthServiceError"
  }
}

export interface AdminCreationStore {
  withAdminLock: <T>(
    work: (store: AdminCreationStore) => Promise<T>
  ) => Promise<T>
  hasAdmin: () => Promise<boolean>
  insertAdmin: (input: {
    id: string
    email: string
    name: string | null
    passwordDigest: string
    sessionId: string
    sessionDigest: Buffer
    sessionExpiresAt: Date
    emailWarningAcknowledged: boolean
    now: Date
  }) => Promise<void>
}

export async function createOnlyAdmin(
  input: {
    email: string
    password: string
    passwordConfirmation: string
    name?: string | null
    acknowledgeEmailWarning?: boolean
    bootstrapToken?: string
  },
  dependencies: {
    store?: AdminCreationStore
    checkReadiness: () => Promise<ReadinessReport>
    verifyBootstrap?: (token: string | undefined) => boolean
    now?: () => Date
  }
) {
  const email = normalizeEmail(input.email)
  const name = normalizeName(input.name)
  const passwordError = validatePassword(input.password)
  if (!isEmail(email)) {
    throw new AuthServiceError("INVALID_INPUT", "Enter a valid email address")
  }
  if (passwordError) {
    throw new AuthServiceError("INVALID_INPUT", passwordError)
  }
  if (input.password !== input.passwordConfirmation) {
    throw new AuthServiceError("INVALID_INPUT", "Passwords do not match")
  }

  const verifyBootstrap =
    dependencies.verifyBootstrap ?? ((token) => verifyBootstrapToken(token))
  // Gate the claim on operator-held proof before any expensive work. This closes the
  // public first-admin takeover and prevents unauthenticated Argon2 amplification.
  if (!verifyBootstrap(input.bootstrapToken)) {
    throw new AuthServiceError(
      "BOOTSTRAP_REQUIRED",
      "A valid setup token is required to create the administrator"
    )
  }

  const store = dependencies.store ?? databaseAdminCreationStore
  // Reject already-initialized installs before paying the Argon2 cost.
  // The authoritative recheck still happens under the advisory lock below.
  if (await store.hasAdmin()) {
    throw new AuthServiceError(
      "ADMIN_EXISTS",
      "Account setup is already complete"
    )
  }

  const passwordDigest = await hashPassword(input.password)
  const session = createSessionToken()

  return store.withAdminLock(async (lockedStore) => {
    if (await lockedStore.hasAdmin()) {
      throw new AuthServiceError(
        "ADMIN_EXISTS",
        "Account setup is already complete"
      )
    }
    // Re-validate the bootstrap credential atomically inside the lock so the winning
    // caller is provably the operator, not whoever raced to the advisory lock first.
    if (!verifyBootstrap(input.bootstrapToken)) {
      throw new AuthServiceError(
        "BOOTSTRAP_REQUIRED",
        "A valid setup token is required to create the administrator"
      )
    }
    const readiness = await dependencies.checkReadiness()
    if (!readiness.canContinue) {
      throw new AuthServiceError(
        "NOT_READY",
        "Complete the required setup first"
      )
    }
    if (
      readiness.requiresEmailAcknowledgement &&
      !input.acknowledgeEmailWarning
    ) {
      throw new AuthServiceError(
        "NOT_READY",
        "Acknowledge disabled alerts to continue"
      )
    }

    const now = dependencies.now?.() ?? new Date()
    const userId = crypto.randomUUID()
    const sessionId = crypto.randomUUID()
    const expiresAt = sessionExpiresAt(now)
    await lockedStore.insertAdmin({
      id: userId,
      email,
      name,
      passwordDigest,
      sessionId,
      sessionDigest: session.digest,
      sessionExpiresAt: expiresAt,
      emailWarningAcknowledged: Boolean(input.acknowledgeEmailWarning),
      now,
    })
    return { userId, email, sessionId, sessionToken: session.raw, expiresAt }
  })
}

const databaseAdminCreationStore: AdminCreationStore = {
  async withAdminLock(work) {
    return db.transaction(async (tx) => {
      await tx.execute(
        drizzleSql`select pg_advisory_xact_lock(hashtext('pulse:first-admin'))`
      )
      const transactionStore: AdminCreationStore = {
        withAdminLock: async (nested) => nested(transactionStore),
        async hasAdmin() {
          const rows = await tx
            .select({ id: adminUsers.id })
            .from(adminUsers)
            .limit(1)
          return rows.length > 0
        },
        async insertAdmin(input) {
          await tx.insert(adminUsers).values({
            id: input.id,
            email: input.email,
            name: input.name,
            passwordDigest: input.passwordDigest,
            createdAt: input.now,
            updatedAt: input.now,
            passwordChangedAt: input.now,
          })
          await tx.insert(onboardingProgress).values({
            userId: input.id,
            currentStep: "monitor",
            emailWarningAcknowledged: input.emailWarningAcknowledged,
            updatedAt: input.now,
          })
          await tx.insert(humanSessions).values({
            id: input.sessionId,
            userId: input.id,
            tokenDigest: input.sessionDigest,
            createdAt: input.now,
            expiresAt: input.sessionExpiresAt,
          })
        },
      }
      return work(transactionStore)
    })
  },
  async hasAdmin() {
    const rows = await db
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .limit(1)
    return rows.length > 0
  },
  async insertAdmin() {
    throw new Error("Admin inserts require the advisory transaction lock")
  },
}

const LOGIN_LIMIT = 5
const LOGIN_WINDOW_SECONDS = 15 * 60
export const LOGIN_RATE_LIMIT_POLICY: RateLimitPolicy = {
  routeKey: "human-login",
  limit: LOGIN_LIMIT,
  windowSeconds: LOGIN_WINDOW_SECONDS,
}

interface LoginUser {
  id: string
  passwordDigest: string
  onboardingCompletedAt: Date | null
}

export interface LoginStore {
  findUser: (email: string) => Promise<LoginUser | null>
  insertSession: (input: {
    userId: string
    currentSessionId?: string | null
    sessionDigest: Buffer
    userAgent: string | null
    ipAddress: string | null
    now: Date
    expiresAt: Date
  }) => Promise<void>
}

export interface LoginDependencies {
  store?: LoginStore
  enforceLimit?: (
    principalKey: string,
    policy: RateLimitPolicy,
    now: Date
  ) => Promise<RateLimitResult>
  digestKey?: (value: string) => Buffer
  verify?: typeof verifyPassword
  createToken?: typeof createSessionToken
  now?: () => Date
}

export function loginRateLimitKey(
  kind: "email" | "ip",
  value: string,
  digest: (value: string) => Buffer = digestBearerToken
) {
  return `login-${kind}:${digest(`human-login:${kind}:${value}`).toString("hex")}`
}

/**
 * Stable principal for the email rate-limit bucket when no account matches.
 * Keeps failed-probe cardinality at one synthetic key instead of one per address.
 */
export const UNKNOWN_LOGIN_EMAIL_BUCKET = "\0pulse-unknown-login"

// Client IP extraction lives in the shared server module. Re-exported so existing
// auth callers keep importing it from here.
export { clientIpFromHeaders, firstForwardedIp }

export async function login(
  input: {
    email: string
    password: string
    ip: string
    userAgent?: string | null
    currentSessionId?: string | null
  },
  dependencies: LoginDependencies = {}
) {
  const email = normalizeEmail(input.email)
  const now = dependencies.now?.() ?? new Date()
  const digest = dependencies.digestKey ?? digestBearerToken
  const limiter = dependencies.enforceLimit ?? enforceRateLimit

  // Enforce the stable source-IP limit first and short-circuit before touching any
  // variable-cardinality bucket: a stream of unique emails can no longer create
  // unbounded rate-limit rows, and the expensive password verify is gated.
  const ipLimit = await limiter(
    loginRateLimitKey("ip", input.ip, digest),
    LOGIN_RATE_LIMIT_POLICY,
    now
  )
  if (!ipLimit.allowed) {
    throw new AuthServiceError(
      "RATE_LIMITED",
      "Sign in failed",
      ipLimit.retryAfterSeconds
    )
  }

  const store = dependencies.store ?? databaseLoginStore
  const user = await store.findUser(email)
  const verify = dependencies.verify ?? verifyPassword
  // Always pay one Argon2 verification so known and unknown addresses have
  // comparable work. Unknown emails verify against a committed dummy digest.
  const passwordMatches = await verify(
    user === null ? LOGIN_DUMMY_PASSWORD_DIGEST : user.passwordDigest,
    input.password
  )

  // A correct password from an IP that is not blocked always recovers: the
  // account-wide bucket is never a hard pre-verification denial, so a stale email
  // bucket can no longer lock the administrator out of a fresh sign-in.
  if (!(user && passwordMatches)) {
    // One email-bucket operation on every failed attempt. Known accounts use
    // their real email key; unknown addresses share a fixed synthetic key so
    // probe cardinality stays bounded.
    const emailBucket = user ? email : UNKNOWN_LOGIN_EMAIL_BUCKET
    const emailLimit = await limiter(
      loginRateLimitKey("email", emailBucket, digest),
      LOGIN_RATE_LIMIT_POLICY,
      now
    )
    if (!emailLimit.allowed) {
      throw new AuthServiceError(
        "RATE_LIMITED",
        "Sign in failed",
        emailLimit.retryAfterSeconds
      )
    }
    throw new AuthServiceError("INVALID_LOGIN", "Sign in failed")
  }

  const token = (dependencies.createToken ?? createSessionToken)()
  const expiresAt = sessionExpiresAt(now)
  await store.insertSession({
    userId: user.id,
    currentSessionId: input.currentSessionId,
    sessionDigest: token.digest,
    userAgent: input.userAgent?.trim().slice(0, 512) || null,
    ipAddress: input.ip === "unknown" ? null : input.ip,
    now,
    expiresAt,
  })
  return {
    token: token.raw,
    expiresAt,
    onboardingComplete: Boolean(user.onboardingCompletedAt),
  }
}

const databaseLoginStore: LoginStore = {
  async findUser(email) {
    const [user] = await db
      .select({
        id: adminUsers.id,
        passwordDigest: adminUsers.passwordDigest,
        onboardingCompletedAt: adminUsers.onboardingCompletedAt,
      })
      .from(adminUsers)
      .where(eq(adminUsers.email, email))
      .limit(1)
    return user ?? null
  },
  async insertSession(input) {
    await db.transaction(async (tx) => {
      if (input.currentSessionId) {
        await tx
          .update(humanSessions)
          .set({ revokedAt: input.now })
          .where(eq(humanSessions.id, input.currentSessionId))
      }
      await tx.insert(humanSessions).values({
        id: crypto.randomUUID(),
        userId: input.userId,
        tokenDigest: input.sessionDigest,
        userAgent: input.userAgent,
        ipAddress: input.ipAddress,
        createdAt: input.now,
        expiresAt: input.expiresAt,
      })
    })
  },
}

export async function hasAdministrator(): Promise<boolean> {
  return databaseAdminCreationStore.hasAdmin()
}

export async function revokeSession(sessionId: string) {
  await db
    .update(humanSessions)
    .set({ revokedAt: new Date() })
    .where(eq(humanSessions.id, sessionId))
}

const LAST_SEEN_REFRESH_SECONDS = 60

/**
 * lastSeenAt is load-bearing for the Security page but written from every
 * authenticated request, so refresh it at most once per minute per session.
 */
export function shouldRefreshLastSeen(
  lastSeenAt: Date | null,
  now: Date
): boolean {
  return (
    lastSeenAt === null ||
    now.getTime() - lastSeenAt.getTime() > LAST_SEEN_REFRESH_SECONDS * 1000
  )
}

interface HumanSessionRecord extends HumanSession {
  lastSeenAt: Date | null
}

export async function findSessionByDigest(
  digest: Buffer,
  now = new Date()
): Promise<HumanSessionRecord | null> {
  const [row] = await db
    .select({
      sessionId: humanSessions.id,
      userId: adminUsers.id,
      email: adminUsers.email,
      timezone: adminUsers.timezone,
      expiresAt: humanSessions.expiresAt,
      onboardingCompletedAt: adminUsers.onboardingCompletedAt,
      lastSeenAt: humanSessions.lastSeenAt,
    })
    .from(humanSessions)
    .innerJoin(adminUsers, eq(adminUsers.id, humanSessions.userId))
    .where(
      and(
        eq(humanSessions.tokenDigest, digest),
        isNull(humanSessions.revokedAt),
        gt(humanSessions.expiresAt, now)
      )
    )
    .limit(1)
  return row ?? null
}

export async function recordHumanSessionActivity(
  sessionId: string,
  lastSeenAt: Date | null,
  now = new Date()
): Promise<void> {
  if (!shouldRefreshLastSeen(lastSeenAt, now)) {
    return
  }
  const cutoff = new Date(now.getTime() - LAST_SEEN_REFRESH_SECONDS * 1000)
  const record = () =>
    db
      .update(humanSessions)
      .set({ lastSeenAt: now })
      .where(
        and(
          eq(humanSessions.id, sessionId),
          or(
            isNull(humanSessions.lastSeenAt),
            lt(humanSessions.lastSeenAt, cutoff)
          )
        )
      )
  try {
    // Off the render critical path. The Security page tolerates a refresh
    // that lands after the response, only the minute-level bound matters.
    after(record)
  } catch {
    // after() requires a request scope; direct callers (tests) update inline.
    await record()
  }
}

export async function authenticateSessionByDigest(
  digest: Buffer,
  now = new Date()
): Promise<HumanSession | null> {
  const record = await findSessionByDigest(digest, now)
  if (!record) {
    return null
  }
  const { lastSeenAt, ...session } = record
  await recordHumanSessionActivity(session.sessionId, lastSeenAt, now)
  return session
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

// The name is optional at first run. An empty or whitespace-only value stays
// null, and anything over the settings cap is rejected so both entry points
// agree on the 1 to 120 character bound.
function normalizeName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== "string") {
    throw new AuthServiceError(
      "INVALID_INPUT",
      "Name must contain 1 to 120 characters"
    )
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  if (trimmed.length > 120) {
    throw new AuthServiceError(
      "INVALID_INPUT",
      "Name must contain 1 to 120 characters"
    )
  }
  return trimmed
}
