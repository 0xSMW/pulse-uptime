import "server-only";

import { and, eq, gt, isNull, sql as drizzleSql } from "drizzle-orm";
import { after } from "next/server";

import { db } from "@/lib/db/client";
import { adminUsers, humanSessions, onboardingProgress } from "@/lib/db/schema";
import { enforceRateLimit, type RateLimitPolicy, type RateLimitResult } from "@/lib/api/rate-limit";
import { digestBearerToken } from "@/lib/api/tokens";
import { verifyBootstrapToken } from "@/lib/onboarding/bootstrap";
import type { ReadinessReport } from "@/lib/readiness/types";

import {
  createSessionToken,
  hashPassword,
  normalizeEmail,
  sessionExpiresAt,
  validatePassword,
  verifyPassword,
} from "./credentials";

export type HumanSession = {
  sessionId: string;
  userId: string;
  email: string;
  expiresAt: Date;
  onboardingCompletedAt: Date | null;
};

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
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AuthServiceError";
  }
}

export interface AdminCreationStore {
  withAdminLock<T>(work: (store: AdminCreationStore) => Promise<T>): Promise<T>;
  hasAdmin(): Promise<boolean>;
  insertAdmin(input: {
    id: string;
    email: string;
    passwordDigest: string;
    sessionId: string;
    sessionDigest: Buffer;
    sessionExpiresAt: Date;
    emailWarningAcknowledged: boolean;
    now: Date;
  }): Promise<void>;
}

export async function createOnlyAdmin(
  input: {
    email: string;
    password: string;
    passwordConfirmation: string;
    acknowledgeEmailWarning?: boolean;
    bootstrapToken?: string;
  },
  dependencies: {
    store?: AdminCreationStore;
    checkReadiness: () => Promise<ReadinessReport>;
    verifyBootstrap?: (token: string | undefined) => boolean;
    now?: () => Date;
  },
) {
  const email = normalizeEmail(input.email);
  const passwordError = validatePassword(input.password);
  if (!isEmail(email)) throw new AuthServiceError("INVALID_INPUT", "Enter a valid email address");
  if (passwordError) throw new AuthServiceError("INVALID_INPUT", passwordError);
  if (input.password !== input.passwordConfirmation) {
    throw new AuthServiceError("INVALID_INPUT", "Passwords do not match");
  }

  const verifyBootstrap = dependencies.verifyBootstrap ?? ((token) => verifyBootstrapToken(token));
  // Gate the claim on operator-held proof before any expensive work. This closes the
  // public first-admin takeover and prevents unauthenticated Argon2 amplification.
  if (!verifyBootstrap(input.bootstrapToken)) {
    throw new AuthServiceError("BOOTSTRAP_REQUIRED", "A valid setup token is required to create the administrator");
  }

  const store = dependencies.store ?? databaseAdminCreationStore;
  // Reject already-initialized installs before paying the Argon2 cost.
  // The authoritative recheck still happens under the advisory lock below.
  if (await store.hasAdmin()) {
    throw new AuthServiceError("ADMIN_EXISTS", "Account setup is already complete");
  }

  const passwordDigest = await hashPassword(input.password);
  const session = createSessionToken();

  return store.withAdminLock(async (lockedStore) => {
    if (await lockedStore.hasAdmin()) {
      throw new AuthServiceError("ADMIN_EXISTS", "Account setup is already complete");
    }
    // Re-validate the bootstrap credential atomically inside the lock so the winning
    // caller is provably the operator, not whoever raced to the advisory lock first.
    if (!verifyBootstrap(input.bootstrapToken)) {
      throw new AuthServiceError("BOOTSTRAP_REQUIRED", "A valid setup token is required to create the administrator");
    }
    const readiness = await dependencies.checkReadiness();
    if (!readiness.canContinue) {
      throw new AuthServiceError("NOT_READY", "Complete the required setup first");
    }
    if (readiness.requiresEmailAcknowledgement && !input.acknowledgeEmailWarning) {
      throw new AuthServiceError("NOT_READY", "Acknowledge disabled alerts to continue");
    }

    const now = dependencies.now?.() ?? new Date();
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const expiresAt = sessionExpiresAt(now);
    await lockedStore.insertAdmin({
      id: userId,
      email,
      passwordDigest,
      sessionId,
      sessionDigest: session.digest,
      sessionExpiresAt: expiresAt,
      emailWarningAcknowledged: Boolean(input.acknowledgeEmailWarning),
      now,
    });
    return { userId, email, sessionId, sessionToken: session.raw, expiresAt };
  });
}

const databaseAdminCreationStore: AdminCreationStore = {
  async withAdminLock(work) {
    return db.transaction(async (tx) => {
      await tx.execute(drizzleSql`select pg_advisory_xact_lock(hashtext('pulse:first-admin'))`);
      const transactionStore: AdminCreationStore = {
        withAdminLock: async (nested) => nested(transactionStore),
        async hasAdmin() {
          const rows = await tx.select({ id: adminUsers.id }).from(adminUsers).limit(1);
          return rows.length > 0;
        },
        async insertAdmin(input) {
          await tx.insert(adminUsers).values({
            id: input.id,
            email: input.email,
            passwordDigest: input.passwordDigest,
            createdAt: input.now,
            updatedAt: input.now,
            passwordChangedAt: input.now,
          });
          await tx.insert(onboardingProgress).values({
            userId: input.id,
            currentStep: "monitor",
            emailWarningAcknowledged: input.emailWarningAcknowledged,
            updatedAt: input.now,
          });
          await tx.insert(humanSessions).values({
            id: input.sessionId,
            userId: input.id,
            tokenDigest: input.sessionDigest,
            createdAt: input.now,
            expiresAt: input.sessionExpiresAt,
          });
        },
      };
      return work(transactionStore);
    });
  },
  async hasAdmin() {
    const rows = await db.select({ id: adminUsers.id }).from(adminUsers).limit(1);
    return rows.length > 0;
  },
  async insertAdmin() {
    throw new Error("Admin inserts require the advisory transaction lock");
  },
};

const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_RATE_LIMIT_POLICY: RateLimitPolicy = {
  routeKey: "human-login",
  limit: LOGIN_LIMIT,
  windowSeconds: LOGIN_WINDOW_SECONDS,
};

type LoginUser = {
  id: string;
  passwordDigest: string;
  onboardingCompletedAt: Date | null;
};

export interface LoginStore {
  findUser(email: string): Promise<LoginUser | null>;
  insertSession(input: {
    userId: string;
    currentSessionId?: string | null;
    sessionDigest: Buffer;
    now: Date;
    expiresAt: Date;
  }): Promise<void>;
}

export type LoginDependencies = {
  store?: LoginStore;
  enforceLimit?: (principalKey: string, policy: RateLimitPolicy, now: Date) => Promise<RateLimitResult>;
  digestKey?: (value: string) => Buffer;
  verify?: typeof verifyPassword;
  createToken?: typeof createSessionToken;
  now?: () => Date;
};

export function loginRateLimitKey(
  kind: "email" | "ip",
  value: string,
  digest: (value: string) => Buffer = digestBearerToken,
) {
  return `login-${kind}:${digest(`human-login:${kind}:${value}`).toString("hex")}`;
}

export async function login(
  input: { email: string; password: string; ip: string; currentSessionId?: string | null },
  dependencies: LoginDependencies = {},
) {
  const email = normalizeEmail(input.email);
  const now = dependencies.now?.() ?? new Date();
  const digest = dependencies.digestKey ?? digestBearerToken;
  const limiter = dependencies.enforceLimit ?? enforceRateLimit;

  // Enforce the stable source-IP limit first and short-circuit before touching any
  // variable-cardinality bucket: a stream of unique emails can no longer create
  // unbounded rate-limit rows, and the expensive password verify is gated.
  const ipLimit = await limiter(loginRateLimitKey("ip", input.ip, digest), LOGIN_RATE_LIMIT_POLICY, now);
  if (!ipLimit.allowed) {
    throw new AuthServiceError("RATE_LIMITED", "Sign in failed", ipLimit.retryAfterSeconds);
  }

  const store = dependencies.store ?? databaseLoginStore;
  const user = await store.findUser(email);
  const verify = dependencies.verify ?? verifyPassword;
  const credentialsValid = user ? await verify(user.passwordDigest, input.password) : false;

  // A correct password from an IP that is not blocked always recovers: the
  // account-wide bucket is never a hard pre-verification denial, so a stale email
  // bucket can no longer lock the administrator out of a fresh sign-in.
  if (!user || !credentialsValid) {
    // Only account-wide bucket a known administrator's failed attempts. Unknown
    // emails add nothing to the IP counter here, keeping bucket cardinality bounded.
    if (user) {
      const emailLimit = await limiter(loginRateLimitKey("email", email, digest), LOGIN_RATE_LIMIT_POLICY, now);
      if (!emailLimit.allowed) {
        throw new AuthServiceError("RATE_LIMITED", "Sign in failed", emailLimit.retryAfterSeconds);
      }
    }
    throw new AuthServiceError("INVALID_LOGIN", "Sign in failed");
  }

  const token = (dependencies.createToken ?? createSessionToken)();
  const expiresAt = sessionExpiresAt(now);
  await store.insertSession({
    userId: user.id,
    currentSessionId: input.currentSessionId,
    sessionDigest: token.digest,
    now,
    expiresAt,
  });
  return { token: token.raw, expiresAt, onboardingComplete: Boolean(user.onboardingCompletedAt) };
}

const databaseLoginStore: LoginStore = {
  async findUser(email) {
    const [user] = await db.select({
      id: adminUsers.id,
      passwordDigest: adminUsers.passwordDigest,
      onboardingCompletedAt: adminUsers.onboardingCompletedAt,
    }).from(adminUsers).where(eq(adminUsers.email, email)).limit(1);
    return user ?? null;
  },
  async insertSession(input) {
    await db.transaction(async (tx) => {
      if (input.currentSessionId) {
        await tx.update(humanSessions).set({ revokedAt: input.now }).where(eq(humanSessions.id, input.currentSessionId));
      }
      await tx.insert(humanSessions).values({
        id: crypto.randomUUID(), userId: input.userId, tokenDigest: input.sessionDigest,
        createdAt: input.now, expiresAt: input.expiresAt,
      });
    });
  },
};

export async function hasAdministrator(): Promise<boolean> {
  return databaseAdminCreationStore.hasAdmin();
}

export async function revokeSession(sessionId: string) {
  await db.update(humanSessions).set({ revokedAt: new Date() }).where(eq(humanSessions.id, sessionId));
}

const SESSION_TOUCH_INTERVAL_MS = 5 * 60_000;

export async function findSessionByDigest(digest: Buffer, now = new Date()): Promise<HumanSession | null> {
  const [row] = await db
    .select({
      sessionId: humanSessions.id,
      userId: adminUsers.id,
      email: adminUsers.email,
      expiresAt: humanSessions.expiresAt,
      onboardingCompletedAt: adminUsers.onboardingCompletedAt,
      lastSeenAt: humanSessions.lastSeenAt,
    })
    .from(humanSessions)
    .innerJoin(adminUsers, eq(adminUsers.id, humanSessions.userId))
    .where(and(eq(humanSessions.tokenDigest, digest), isNull(humanSessions.revokedAt), gt(humanSessions.expiresAt, now)))
    .limit(1);
  if (!row) return null;
  const { lastSeenAt, ...session } = row;
  if (!lastSeenAt || now.getTime() - lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
    const touch = () =>
      db.update(humanSessions).set({ lastSeenAt: now }).where(eq(humanSessions.id, row.sessionId));
    try {
      // Off the render critical path; lastSeenAt has no readers that need it fresh.
      after(touch);
    } catch {
      // after() requires a request scope; direct callers (tests) update inline.
      await touch();
    }
  }
  return session;
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
