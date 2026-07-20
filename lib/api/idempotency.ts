import "server-only";

import { createHash } from "node:crypto";

import { and, eq, lt, lte } from "drizzle-orm";

import { canonicalSerialize } from "@/lib/config/canonical";
import { isUuid } from "@/lib/ids/uuid";
import { db } from "@/lib/db/client";
import type { DatabaseHandle } from "@/lib/db/client";
import { apiIdempotency } from "@/lib/db/schema";

// Records written by this atomic protocol carry this marker. A running record
// with this marker proves its mutation and completion share one transaction,
// so a running record past the stale window took no effect and is safe to
// rerun. Legacy running records default to LEGACY_PROTOCOL because their
// mutation could have committed before a separate completion write failed, so
// claimStale refuses to rerun them and they resolve as REQUEST_IN_PROGRESS
// until they expire and are pruned.
export const ATOMIC_PROTOCOL = 1;
export const LEGACY_PROTOCOL = 0;

export type StoredResponse<T = unknown> = { status: number; body: T };
export type IdempotencyContext = {
  operationId: string;
  /**
   * Opens a database transaction, runs `run`, and if it resolves, persists
   * the idempotency record's completion inside that SAME transaction before
   * committing. If `run` throws, the transaction (and the completion) rolls
   * back, so the record is left running, which now truthfully means "no
   * effect committed". work() must return exactly what this returns.
   * Callable at most once per execution.
   */
  transaction: <R>(run: (tx: DatabaseHandle) => Promise<StoredResponse<R>>) => Promise<StoredResponse<R>>;
};
export type IdempotencyRecord = typeof apiIdempotency.$inferSelect;
export type IdempotencyPersistence = {
  insertRunning(value: typeof apiIdempotency.$inferInsert): Promise<string | undefined>;
  findOwner(principalKey: string, idempotencyKey: string): Promise<IdempotencyRecord | undefined>;
  reclaimExpired(id: string, now: Date, value: typeof apiIdempotency.$inferInsert): Promise<string | null>;
  claimStale(id: string, staleBefore: Date, now: Date, expiresAt: Date): Promise<string | undefined>;
  lockOwner(id: string, tx: DatabaseHandle): Promise<void>;
  transaction<R>(run: (tx: DatabaseHandle) => Promise<R>): Promise<R>;
  complete(id: string, status: number, body: unknown, completedAt: Date, tx?: DatabaseHandle): Promise<void>;
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
  /**
   * Fingerprinted together with method/path/query into requestHash (below).
   * This is the ONLY input the "same key, different request" check sees.
   * Pass more than the parsed request body when the route has additional
   * preconditions that must invalidate a replay when they change (e.g. an
   * If-Match value): fold them in here (see the status-page-config PUT
   * route), not just the document itself, or a key reused with the same
   * document but a fresh precondition will replay the stale response.
   */
  body: unknown;
  retentionSeconds?: number;
  now?: Date;
  work: (context: IdempotencyContext) => Promise<StoredResponse<T>>;
  persistBody?: (body: T) => unknown;
  replayBody?: (storedBody: unknown, context: IdempotencyContext) => Promise<T> | T;
  persistence?: IdempotencyPersistence;
}): Promise<StoredResponse<T> & { replayed: boolean }> {
  const key = requireIdempotencyKey(input.request);
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
    protocol: ATOMIC_PROTOCOL,
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
        protocol: ATOMIC_PROTOCOL,
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
          ? await input.replayBody(existing.responseBody, replayContext(existing.id))
          : existing.responseBody as T,
        replayed: true,
      };
    }
    const staleBefore = new Date(now.getTime() - 5 * 60_000);
    if (existing.createdAt > staleBefore) {
      throw new IdempotencyError("REQUEST_IN_PROGRESS", "A request with this idempotency key is still running");
    }
    // Completion now commits atomically with the mutation, so a running
    // record past the stale window proves the prior attempt never took
    // effect, as of the read above. A live owner holds a row lock on its
    // record for the life of its mutation, so this claimStale UPDATE blocks
    // until that owner settles. If the owner committed, the record is now
    // completed, claimStale matches nothing, and the client's next retry
    // replays it. If the owner rolled back, the record is still running and
    // claimStale reclaims it for a safe rerun. A legacy record from before
    // the atomic protocol carries no such lock and no protocol marker, so
    // claimStale refuses it and the caller falls back to REQUEST_IN_PROGRESS.
    recordId = await persistence.claimStale(existing.id, staleBefore, now, expiresAt);
    if (!recordId) {
      throw new IdempotencyError("REQUEST_IN_PROGRESS", "A request with this idempotency key is still running");
    }
  }

  const operationId = recordId;
  let transactionUsed = false;
  const context: IdempotencyContext = {
    operationId,
    transaction: async (run) => {
      if (transactionUsed) {
        throw new Error("context.transaction can only be called once per idempotent execution");
      }
      transactionUsed = true;
      return await persistence.transaction(async (tx) => {
        // Hold a row lock on this operation's own idempotency record for the
        // whole mutation transaction. A concurrent retry that reaches the
        // stale window blocks in claimStale until this transaction settles.
        // On commit the record is completed, so claimStale matches nothing
        // and the retry replays. On rollback nothing committed and the record
        // is still running, so the retry reclaims it and reruns safely. This
        // is what keeps a slow but live owner from being reclaimed and run a
        // second time concurrently.
        await persistence.lockOwner(operationId, tx);
        const result = await run(tx);
        // context.transaction is generic in R so any route's work() can use
        // it, but a route only ever instantiates it at its own T (work()
        // must return exactly what this call returns), so this cast is safe.
        await persistence.complete(
          operationId,
          result.status,
          input.persistBody ? input.persistBody(result.body as unknown as T) : result.body,
          new Date(),
          tx,
        );
        return result;
      });
    },
  };

  const result = await input.work(context);
  // Routes with no database mutation to be atomic with never call
  // context.transaction, so completion falls back to this post-hoc write.
  if (!transactionUsed) {
    await complete(persistence, operationId, result, input.persistBody);
  }
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

// Only replayBody sees this, and it only ever reads operationId. There is no
// mutation to make atomic with a replay, so opening a transaction here is a
// programmer error, not a supported path.
function replayContext(operationId: string): IdempotencyContext {
  return {
    operationId,
    transaction: () => { throw new Error("context.transaction is not available while replaying a stored response"); },
  };
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
    // A completed record must never be reclaimed. complete() does not touch
    // createdAt, so an age check alone would still match a record whose
    // owner finished just after we read it, letting a retry take over an
    // already-completed record and overwrite its stored response. The
    // state = "running" condition closes that race: if it doesn't match,
    // the caller falls back to REQUEST_IN_PROGRESS and the next retry reads
    // the completed record and replays it. A live owner also holds a row
    // lock on this record, so this UPDATE blocks until that owner commits
    // (state becomes completed, no match) or rolls back (still running,
    // match). The protocol = ATOMIC_PROTOCOL condition excludes legacy
    // records, whose committed mutation could predate a failed completion
    // write, so they are never rerun and instead resolve as
    // REQUEST_IN_PROGRESS until they expire and are pruned.
    return (await db.update(apiIdempotency).set({ createdAt: now, expiresAt })
      .where(and(
        eq(apiIdempotency.id, id),
        eq(apiIdempotency.state, "running"),
        eq(apiIdempotency.protocol, ATOMIC_PROTOCOL),
        lt(apiIdempotency.createdAt, staleBefore),
      ))
      .returning({ id: apiIdempotency.id }))[0]?.id;
  },
  async lockOwner(id, tx) {
    // Take a FOR UPDATE row lock on this operation's own record so a
    // concurrent stale claim blocks until this transaction commits or rolls
    // back. The lock lives for the enclosing transaction.
    await tx.select({ id: apiIdempotency.id }).from(apiIdempotency)
      .where(eq(apiIdempotency.id, id)).for("update");
  },
  async transaction(run) {
    return await db.transaction(run);
  },
  async complete(id, status, body, completedAt, tx) {
    await (tx ?? db).update(apiIdempotency).set({
      state: "completed", responseStatus: status, responseBody: body, completedAt,
    }).where(eq(apiIdempotency.id, id));
  },
};

// Preflight the Idempotency-Key header before any work. executeIdempotent runs
// this too, so routes that derive credentials from the key can reject a missing
// or malformed key up front and reuse the same trimmed value.
export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key || !isUuid(key)) {
    throw new IdempotencyError("IDEMPOTENCY_KEY_REQUIRED", "A UUID Idempotency-Key is required");
  }
  return key;
}
