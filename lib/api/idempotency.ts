import "server-only";

import { createHash } from "node:crypto";

import { and, eq, lt, lte } from "drizzle-orm";

import { canonicalSerialize } from "@/lib/config/canonical";
import { db } from "@/lib/db/client";
import { apiIdempotency } from "@/lib/db/schema";

export type StoredResponse<T = unknown> = { status: number; body: T };
export type IdempotencyContext = { operationId: string };
export type IdempotencyRecord = typeof apiIdempotency.$inferSelect;
export type IdempotencyPersistence = {
  insertRunning(value: typeof apiIdempotency.$inferInsert): Promise<string | undefined>;
  findOwner(principalKey: string, idempotencyKey: string): Promise<IdempotencyRecord | undefined>;
  reclaimExpired(id: string, now: Date, value: typeof apiIdempotency.$inferInsert): Promise<string | null>;
  claimStale(id: string, staleBefore: Date, now: Date, expiresAt: Date): Promise<string | undefined>;
  complete(id: string, status: number, body: unknown, completedAt: Date): Promise<void>;
};

export class IdempotencyError extends Error {
  constructor(
    readonly code: "IDEMPOTENCY_KEY_REQUIRED" | "IDEMPOTENCY_KEY_REUSED" | "REQUEST_IN_PROGRESS",
    message: string,
  ) {
    super(message);
    this.name = "IdempotencyError";
  }
}

export async function executeIdempotent<T>(input: {
  request: Request;
  principalKey: string;
  routeKey: string;
  body: unknown;
  retentionSeconds?: number;
  now?: Date;
  work: (context: IdempotencyContext) => Promise<StoredResponse<T>>;
  recover?: (context: IdempotencyContext) => Promise<StoredResponse<T> | null>;
  rerunAfterRecoveryMiss?: boolean;
  persistBody?: (body: T) => unknown;
  replayBody?: (storedBody: unknown, context: IdempotencyContext) => Promise<T> | T;
  persistence?: IdempotencyPersistence;
}): Promise<StoredResponse<T> & { replayed: boolean }> {
  const key = input.request.headers.get("idempotency-key")?.trim();
  if (!key || !isUuid(key)) {
    throw new IdempotencyError("IDEMPOTENCY_KEY_REQUIRED", "A UUID Idempotency-Key is required");
  }
  const now = input.now ?? new Date();
  const persistence = input.persistence ?? databaseIdempotencyPersistence;
  const retentionSeconds = input.retentionSeconds ?? 86_400;
  const url = new URL(input.request.url);
  const query = [...url.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([keyPart, value]) => `${encodeURIComponent(keyPart)}=${encodeURIComponent(value)}`)
    .join("&");
  const requestHash = createHash("sha256")
    .update(`${input.request.method.toUpperCase()}\n${url.pathname}${query ? `?${query}` : ""}\n${canonicalSerialize(input.body)}`)
    .digest("hex");
  const expiresAt = new Date(now.getTime() + retentionSeconds * 1_000);
  const insertRunning = async () => await persistence.insertRunning({
    id: crypto.randomUUID(),
    principalKey: input.principalKey,
    idempotencyKey: key,
    method: input.request.method,
    routeKey: input.routeKey,
    requestHash,
    state: "running",
    createdAt: now,
    expiresAt,
  });
  const findOwner = async () => await persistence.findOwner(input.principalKey, key);

  const acquisition = await acquireIdempotencyOwner({
    now,
    insert: insertRunning,
    find: findOwner,
    reclaim: async (existing) => await reclaimExpiredRecord(existing, now, async (expiredId) => {
      const replacementId = crypto.randomUUID();
      return await persistence.reclaimExpired(expiredId, now, {
        id: replacementId,
        principalKey: input.principalKey,
        idempotencyKey: key,
        method: input.request.method,
        routeKey: input.routeKey,
        requestHash,
        responseStatus: null,
        responseBody: null,
        state: "running",
        createdAt: now,
        completedAt: null,
        expiresAt,
      });
    }),
  });
  let { recordId, existing } = acquisition;

  if (!recordId) {
    existing ??= await findOwner();
    if (!existing) {
      throw new IdempotencyError("REQUEST_IN_PROGRESS", "Idempotency key ownership changed; retry the request");
    }
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was used for a different request");
    }
    if (existing.state === "completed") {
      return {
        status: existing.responseStatus!,
        body: input.replayBody
          ? await input.replayBody(existing.responseBody, { operationId: existing.id })
          : existing.responseBody as T,
        replayed: true,
      };
    } else {
      const staleBefore = new Date(now.getTime() - 5 * 60_000);
      if (existing.createdAt > staleBefore) {
        throw new IdempotencyError("REQUEST_IN_PROGRESS", "A request with this idempotency key is still running");
      }
      recordId = await persistence.claimStale(existing.id, staleBefore, now, expiresAt);
      if (!recordId) {
        throw new IdempotencyError("REQUEST_IN_PROGRESS", "A request with this idempotency key is still running");
      }
      if (input.recover) {
        const recovered = await input.recover({ operationId: recordId });
        if (recovered) {
          await complete(persistence, recordId, recovered, input.persistBody);
          return { ...recovered, replayed: true };
        }
        if (input.rerunAfterRecoveryMiss === false) {
          throw new IdempotencyError(
            "REQUEST_IN_PROGRESS",
            "The prior result cannot be recovered safely. Review current state, then retry with a new idempotency key.",
          );
        }
      }
    }
  }

  const result = await input.work({ operationId: recordId });
  await complete(persistence, recordId, result, input.persistBody);
  return { ...result, replayed: false };
}

export async function reclaimExpiredRecord(
  record: { id: string; expiresAt: Date; state: "running" | "completed" },
  now: Date,
  attempt: (expiredId: string) => Promise<string | null>,
): Promise<string | null> {
  return record.expiresAt <= now ? await attempt(record.id) : null;
}

export async function acquireIdempotencyOwner<R extends { id: string; expiresAt: Date; state: "running" | "completed" }>(input: {
  now: Date;
  insert: () => Promise<string | null | undefined>;
  find: () => Promise<R | undefined>;
  reclaim: (record: R) => Promise<string | null>;
  maxAttempts?: number;
}): Promise<{ recordId?: string; existing?: R }> {
  for (let attempt = 0; attempt < (input.maxAttempts ?? 4); attempt += 1) {
    const inserted = await input.insert();
    if (inserted) return { recordId: inserted };
    const existing = await input.find();
    if (!existing) continue;
    const reclaimed = await input.reclaim(existing);
    if (reclaimed) return { recordId: reclaimed };
    if (existing.expiresAt > input.now) return { existing };
  }
  const existing = await input.find();
  return existing && existing.expiresAt > input.now ? { existing } : {};
}

async function complete<T>(persistence: IdempotencyPersistence, recordId: string, result: StoredResponse<T>, persistBody?: (body: T) => unknown) {
  await persistence.complete(recordId, result.status, persistBody ? persistBody(result.body) : result.body, new Date());
}

const databaseIdempotencyPersistence: IdempotencyPersistence = {
  async insertRunning(value) {
    return (await db.insert(apiIdempotency).values(value).onConflictDoNothing()
      .returning({ id: apiIdempotency.id }))[0]?.id;
  },
  async findOwner(principalKey, idempotencyKey) {
    return (await db.select().from(apiIdempotency).where(and(
      eq(apiIdempotency.principalKey, principalKey),
      eq(apiIdempotency.idempotencyKey, idempotencyKey),
    )).limit(1))[0];
  },
  async reclaimExpired(id, now, value) {
    return (await db.update(apiIdempotency).set(value).where(and(
      eq(apiIdempotency.id, id),
      lte(apiIdempotency.expiresAt, now),
    )).returning({ id: apiIdempotency.id }))[0]?.id ?? null;
  },
  async claimStale(id, staleBefore, now, expiresAt) {
    return (await db.update(apiIdempotency).set({ createdAt: now, expiresAt })
      .where(and(eq(apiIdempotency.id, id), lt(apiIdempotency.createdAt, staleBefore)))
      .returning({ id: apiIdempotency.id }))[0]?.id;
  },
  async complete(id, status, body, completedAt) {
    await db.update(apiIdempotency).set({
      state: "completed", responseStatus: status, responseBody: body, completedAt,
    }).where(eq(apiIdempotency.id, id));
  },
};

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
