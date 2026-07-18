import "server-only";

import { and, eq, gt, isNull, sql as drizzleSql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { adminUsers, humanSessions, onboardingProgress } from "@/lib/db/schema";
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

type Attempt = { count: number; resetAt: number };
const attempts = new Map<string, Attempt>();
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;

export async function login(input: { email: string; password: string; ip: string; currentSessionId?: string | null }) {
  const email = normalizeEmail(input.email);
  const now = new Date();
  const keys = [`email:${email}`, `ip:${input.ip}`];
  if (keys.some((key) => isLimited(key, now.getTime()))) {
    throw new AuthServiceError("RATE_LIMITED", "Sign in failed");
  }

  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.email, email)).limit(1);
  const valid = user ? await verifyPassword(user.passwordDigest, input.password) : false;
  if (!valid) {
    keys.forEach((key) => recordFailure(key, now.getTime()));
    throw new AuthServiceError("INVALID_LOGIN", "Sign in failed");
  }

  keys.forEach((key) => attempts.delete(key));
  const token = createSessionToken();
  const expiresAt = sessionExpiresAt(now);
  await db.transaction(async (tx) => {
    if (input.currentSessionId) {
      await tx.update(humanSessions).set({ revokedAt: now }).where(eq(humanSessions.id, input.currentSessionId));
    }
    await tx.insert(humanSessions).values({
      id: crypto.randomUUID(), userId: user.id, tokenDigest: token.digest,
      createdAt: now, expiresAt,
    });
  });
  return { token: token.raw, expiresAt, onboardingComplete: Boolean(user.onboardingCompletedAt) };
}

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

function isLimited(key: string, now: number) {
  const attempt = attempts.get(key);
  if (!attempt || attempt.resetAt <= now) {
    attempts.delete(key);
    return false;
  }
  return attempt.count >= LOGIN_LIMIT;
}

function recordFailure(key: string, now: number) {
  const current = attempts.get(key);
  attempts.set(key, current && current.resetAt > now
    ? { ...current, count: current.count + 1 }
    : { count: 1, resetAt: now + LOGIN_WINDOW_MS });
}
