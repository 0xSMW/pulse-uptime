import "server-only";

import { and, eq, gt, isNull, sql as drizzleSql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { adminUsers, humanSessions, onboardingProgress } from "@/lib/db/schema";
import { enforceRateLimit, type RateLimitPolicy, type RateLimitResult } from "@/lib/api/rate-limit";
import { digestBearerToken } from "@/lib/api/tokens";
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
  input: { email: string; password: string; passwordConfirmation: string; acknowledgeEmailWarning?: boolean },
  dependencies: {
    store?: AdminCreationStore;
    checkReadiness: () => Promise<ReadinessReport>;
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

  const passwordDigest = await hashPassword(input.password);
  const session = createSessionToken();
  const store = dependencies.store ?? databaseAdminCreationStore;

  return store.withAdminLock(async (lockedStore) => {
    if (await lockedStore.hasAdmin()) {
      throw new AuthServiceError("ADMIN_EXISTS", "Account setup is already complete");
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
  const keys = [
    loginRateLimitKey("email", email, digest),
    loginRateLimitKey("ip", input.ip, digest),
  ];
  const limiter = dependencies.enforceLimit ?? enforceRateLimit;
  const limits = await Promise.all(
    keys.map((key) => limiter(key, LOGIN_RATE_LIMIT_POLICY, now)),
  );
  const blocked = limits.filter((result) => !result.allowed);
  if (blocked.length > 0) {
    throw new AuthServiceError(
      "RATE_LIMITED",
      "Sign in failed",
      Math.max(...blocked.map((result) => result.retryAfterSeconds)),
    );
  }

  const store = dependencies.store ?? databaseLoginStore;
  const user = await store.findUser(email);
  const verify = dependencies.verify ?? verifyPassword;
  if (!user || !(await verify(user.passwordDigest, input.password))) {
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

export async function revokeSession(sessionId: string) {
  await db.update(humanSessions).set({ revokedAt: new Date() }).where(eq(humanSessions.id, sessionId));
}

export async function findSessionByDigest(digest: Buffer, now = new Date()): Promise<HumanSession | null> {
  const [row] = await db
    .select({
      sessionId: humanSessions.id,
      userId: adminUsers.id,
      email: adminUsers.email,
      expiresAt: humanSessions.expiresAt,
      onboardingCompletedAt: adminUsers.onboardingCompletedAt,
    })
    .from(humanSessions)
    .innerJoin(adminUsers, eq(adminUsers.id, humanSessions.userId))
    .where(and(eq(humanSessions.tokenDigest, digest), isNull(humanSessions.revokedAt), gt(humanSessions.expiresAt, now)))
    .limit(1);
  if (!row) return null;
  await db.update(humanSessions).set({ lastSeenAt: now }).where(eq(humanSessions.id, row.sessionId));
  return row;
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
