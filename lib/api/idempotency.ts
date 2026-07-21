import "server-only"

import { createHash } from "node:crypto"

import { and, eq, inArray, lt, lte } from "drizzle-orm"

import { canonicalSerialize } from "@/lib/config/canonical"
import type { DatabaseHandle } from "@/lib/db/client"
import { db } from "@/lib/db/client"
import { apiIdempotency } from "@/lib/db/schema"
import { isUuid } from "@/lib/ids/uuid"

// Protocol values written on the running record at claim time. claimStale only
// reclaims protocols that declare a safe re-execution invariant.
//
// 0 — conservative / legacy. Post-hoc completion. A running record past the
//     stale window may have committed work before a separate completion write
//     failed, so claimStale refuses to rerun it until the row expires.
// 1 — atomic. Mutation and completion share one transaction the helper owns.
//     A running record past the stale window took no effect and is safe to
//     reclaim. A live owner holds a row lock for the life of that transaction.
// 2 — replay-safe. Post-hoc completion, but the operation has a named
//     downstream retry invariant (unique key, deterministic upsert, etc.), so
//     stale reclaim and re-execution are safe.
export const CONSERVATIVE_PROTOCOL = 0
export const ATOMIC_PROTOCOL = 1
export const REPLAY_SAFE_PROTOCOL = 2
/** Alias for rows written before the atomic protocol existed. */
export const LEGACY_PROTOCOL = CONSERVATIVE_PROTOCOL

export type IdempotencyMode = "atomic" | "replay_safe" | "conservative"

const PROTOCOL_BY_MODE: Record<IdempotencyMode, number> = {
  atomic: ATOMIC_PROTOCOL,
  replay_safe: REPLAY_SAFE_PROTOCOL,
  conservative: CONSERVATIVE_PROTOCOL,
}

/** Protocols whose running records may be stale-reclaimed and re-executed. */
export const RECLAIMABLE_PROTOCOLS = [
  ATOMIC_PROTOCOL,
  REPLAY_SAFE_PROTOCOL,
] as const

export function protocolForMode(mode: IdempotencyMode): number {
  return PROTOCOL_BY_MODE[mode]
}

export function allowsStaleReclaim(protocol: number): boolean {
  return (
    protocol === ATOMIC_PROTOCOL || protocol === REPLAY_SAFE_PROTOCOL
  )
}

export interface StoredResponse<T = unknown> {
  status: number
  body: T
}

/** Context passed to work() and replayBody. No transaction escape hatch. */
export interface IdempotencyWorkContext {
  operationId: string
}

export type IdempotencyRecord = typeof apiIdempotency.$inferSelect
export interface IdempotencyPersistence {
  insertRunning: (
    value: typeof apiIdempotency.$inferInsert
  ) => Promise<string | undefined>
  findOwner: (
    principalKey: string,
    idempotencyKey: string
  ) => Promise<IdempotencyRecord | undefined>
  reclaimExpired: (
    id: string,
    now: Date,
    value: typeof apiIdempotency.$inferInsert
  ) => Promise<string | null>
  claimStale: (
    id: string,
    staleBefore: Date,
    now: Date,
    expiresAt: Date
  ) => Promise<string | undefined>
  lockOwner: (id: string, tx: DatabaseHandle) => Promise<void>
  transaction: <R>(run: (tx: DatabaseHandle) => Promise<R>) => Promise<R>
  complete: (
    id: string,
    status: number,
    body: unknown,
    completedAt: Date,
    tx?: DatabaseHandle
  ) => Promise<void>
}

export class IdempotencyError extends Error {
  constructor(
    readonly code:
      | "IDEMPOTENCY_KEY_REQUIRED"
      | "IDEMPOTENCY_KEY_REUSED"
      | "REQUEST_IN_PROGRESS",
    message: string
  ) {
    super(message)
    this.name = "IdempotencyError"
  }
}

type ExecuteIdempotentBase<T> = {
  request: Request
  principalKey: string
  routeKey: string
  /**
   * Fingerprinted together with method/path/query into requestHash (below).
   * This is the ONLY input the "same key, different request" check sees.
   * Pass more than the parsed request body when the route has additional
   * preconditions that must invalidate a replay when they change (e.g. an
   * If-Match value): fold them in here (see the status-page-config PUT
   * route), not just the document itself, or a key reused with the same
   * document but a fresh precondition will replay the stale response.
   */
  body: unknown
  retentionSeconds?: number
  now?: Date
  persistBody?: (body: T) => unknown
  replayBody?: (
    storedBody: unknown,
    context: IdempotencyWorkContext
  ) => Promise<T> | T
  persistence?: IdempotencyPersistence
}

export type ExecuteIdempotentAtomicInput<T> = ExecuteIdempotentBase<T> & {
  mode: "atomic"
  /**
   * Runs inside a transaction the helper opens. Completion is written on the
   * same handle before commit. Callers cannot complete atomic work outside
   * this transaction: there is no post-hoc path for mode "atomic".
   */
  work: (
    tx: DatabaseHandle,
    context: IdempotencyWorkContext
  ) => Promise<StoredResponse<T>>
}

export type ExecuteIdempotentPostHocInput<T> = ExecuteIdempotentBase<T> & {
  mode: "replay_safe" | "conservative"
  /**
   * Runs outside any helper-owned transaction. Completion is written after
   * work resolves. replay_safe permits stale reclaim; conservative does not.
   */
  work: (context: IdempotencyWorkContext) => Promise<StoredResponse<T>>
}

export type ExecuteIdempotentInput<T> =
  | ExecuteIdempotentAtomicInput<T>
  | ExecuteIdempotentPostHocInput<T>

export async function executeIdempotent<T>(
  input: ExecuteIdempotentInput<T>
): Promise<StoredResponse<T> & { replayed: boolean }> {
  const key = requireIdempotencyKey(input.request)
  const now = input.now ?? new Date()
  const persistence = input.persistence ?? databaseIdempotencyPersistence
  const retentionSeconds = input.retentionSeconds ?? 86_400
  const protocol = protocolForMode(input.mode)
  const url = new URL(input.request.url)
  const query = [...url.searchParams.entries()]
    .sort(
      ([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    )
    .map(
      ([keyPart, value]) =>
        `${encodeURIComponent(keyPart)}=${encodeURIComponent(value)}`
    )
    .join("&")
  const requestHash = createHash("sha256")
    .update(
      `${input.request.method.toUpperCase()}\n${url.pathname}${query ? `?${query}` : ""}\n${canonicalSerialize(input.body)}`
    )
    .digest("hex")
  const expiresAt = new Date(now.getTime() + retentionSeconds * 1000)
  const insertRunning = async () =>
    await persistence.insertRunning({
      id: crypto.randomUUID(),
      principalKey: input.principalKey,
      idempotencyKey: key,
      method: input.request.method,
      routeKey: input.routeKey,
      requestHash,
      protocol,
      state: "running",
      createdAt: now,
      expiresAt,
    })
  const findOwner = async () =>
    await persistence.findOwner(input.principalKey, key)

  const acquisition = await acquireIdempotencyOwner({
    now,
    insert: insertRunning,
    find: findOwner,
    reclaim: async (expiredOwner) =>
      await reclaimExpiredRecord(expiredOwner, now, async (expiredId) => {
        const replacementId = crypto.randomUUID()
        return await persistence.reclaimExpired(expiredId, now, {
          id: replacementId,
          principalKey: input.principalKey,
          idempotencyKey: key,
          method: input.request.method,
          routeKey: input.routeKey,
          requestHash,
          protocol,
          responseStatus: null,
          responseBody: null,
          state: "running",
          createdAt: now,
          completedAt: null,
          expiresAt,
        })
      }),
  })
  let { recordId, existing } = acquisition

  if (!recordId) {
    existing ??= await findOwner()
    if (!existing) {
      throw new IdempotencyError(
        "REQUEST_IN_PROGRESS",
        "Idempotency key ownership changed; retry the request"
      )
    }
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyError(
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency key was used for a different request"
      )
    }
    if (existing.state === "completed") {
      return {
        status: existing.responseStatus!,
        body: input.replayBody
          ? await input.replayBody(
              existing.responseBody,
              { operationId: existing.id }
            )
          : (existing.responseBody as T),
        replayed: true,
      }
    }
    const staleBefore = new Date(now.getTime() - 5 * 60_000)
    if (existing.createdAt > staleBefore) {
      throw new IdempotencyError(
        "REQUEST_IN_PROGRESS",
        "A request with this idempotency key is still running"
      )
    }
    // claimStale only matches reclaimable protocols (atomic, replay-safe).
    // Conservative and legacy rows stay REQUEST_IN_PROGRESS until expiry.
    // A live atomic owner holds a row lock on its record for the life of its
    // mutation, so this claimStale UPDATE blocks until that owner settles.
    recordId = await persistence.claimStale(
      existing.id,
      staleBefore,
      now,
      expiresAt
    )
    if (!recordId) {
      throw new IdempotencyError(
        "REQUEST_IN_PROGRESS",
        "A request with this idempotency key is still running"
      )
    }
  }

  const operationId = recordId
  const workContext: IdempotencyWorkContext = { operationId }

  if (input.mode === "atomic") {
    // Helper owns the transaction. work receives tx + operationId and cannot
    // escape: completion is written on the same handle before commit.
    const result = await persistence.transaction(async (tx) => {
      // Hold a row lock on this operation's own idempotency record for the
      // whole mutation transaction. A concurrent retry that reaches the
      // stale window blocks in claimStale until this transaction settles.
      await persistence.lockOwner(operationId, tx)
      const result = await input.work(tx, workContext)
      await persistence.complete(
        operationId,
        result.status,
        input.persistBody ? input.persistBody(result.body) : result.body,
        new Date(),
        tx
      )
      return result
    })
    return { ...result, replayed: false }
  }

  // replay_safe and conservative: post-hoc completion after work resolves.
  const result = await input.work(workContext)
  await complete(persistence, operationId, result, input.persistBody)
  return { ...result, replayed: false }
}

export async function reclaimExpiredRecord(
  record: { id: string; expiresAt: Date; state: "running" | "completed" },
  now: Date,
  attempt: (expiredId: string) => Promise<string | null>
): Promise<string | null> {
  return record.expiresAt <= now ? await attempt(record.id) : null
}

export async function acquireIdempotencyOwner<
  R extends { id: string; expiresAt: Date; state: "running" | "completed" },
>(input: {
  now: Date
  insert: () => Promise<string | null | undefined>
  find: () => Promise<R | undefined>
  reclaim: (record: R) => Promise<string | null>
  maxAttempts?: number
}): Promise<{ recordId?: string; existing?: R }> {
  for (let attempt = 0; attempt < (input.maxAttempts ?? 4); attempt += 1) {
    const inserted = await input.insert()
    if (inserted) {
      return { recordId: inserted }
    }
    const existing = await input.find()
    if (!existing) {
      continue
    }
    const reclaimed = await input.reclaim(existing)
    if (reclaimed) {
      return { recordId: reclaimed }
    }
    if (existing.expiresAt > input.now) {
      return { existing }
    }
  }
  const existing = await input.find()
  return existing && existing.expiresAt > input.now ? { existing } : {}
}

async function complete<T>(
  persistence: IdempotencyPersistence,
  recordId: string,
  result: StoredResponse<T>,
  persistBody?: (body: T) => unknown
) {
  await persistence.complete(
    recordId,
    result.status,
    persistBody ? persistBody(result.body) : result.body,
    new Date()
  )
}

const databaseIdempotencyPersistence: IdempotencyPersistence = {
  async insertRunning(value) {
    return (
      await db
        .insert(apiIdempotency)
        .values(value)
        .onConflictDoNothing()
        .returning({ id: apiIdempotency.id })
    )[0]?.id
  },
  async findOwner(principalKey, idempotencyKey) {
    return (
      await db
        .select()
        .from(apiIdempotency)
        .where(
          and(
            eq(apiIdempotency.principalKey, principalKey),
            eq(apiIdempotency.idempotencyKey, idempotencyKey)
          )
        )
        .limit(1)
    )[0]
  },
  async reclaimExpired(id, now, value) {
    return (
      (
        await db
          .update(apiIdempotency)
          .set(value)
          .where(
            and(eq(apiIdempotency.id, id), lte(apiIdempotency.expiresAt, now))
          )
          .returning({ id: apiIdempotency.id })
      )[0]?.id ?? null
    )
  },
  async claimStale(id, staleBefore, now, expiresAt) {
    // A completed record must never be reclaimed. complete() does not touch
    // createdAt, so an age check alone would still match a record whose
    // owner finished just after we read it, letting a retry take over an
    // already-completed record and overwrite its stored response. The
    // state = "running" condition closes that race. A live atomic owner also
    // holds a row lock on this record, so this UPDATE blocks until that owner
    // commits (state becomes completed, no match) or rolls back (still
    // running, match). protocol must be reclaimable: atomic (mutation and
    // completion shared a transaction) or replay-safe (named downstream
    // retry invariant). Conservative and legacy rows are never rerun.
    return (
      await db
        .update(apiIdempotency)
        .set({ createdAt: now, expiresAt })
        .where(
          and(
            eq(apiIdempotency.id, id),
            eq(apiIdempotency.state, "running"),
            inArray(apiIdempotency.protocol, [...RECLAIMABLE_PROTOCOLS]),
            lt(apiIdempotency.createdAt, staleBefore)
          )
        )
        .returning({ id: apiIdempotency.id })
    )[0]?.id
  },
  async lockOwner(id, tx) {
    // Take a FOR UPDATE row lock on this operation's own record so a
    // concurrent stale claim blocks until this transaction commits or rolls
    // back. The lock lives for the enclosing transaction.
    await tx
      .select({ id: apiIdempotency.id })
      .from(apiIdempotency)
      .where(eq(apiIdempotency.id, id))
      .for("update")
  },
  async transaction(run) {
    return await db.transaction(run)
  },
  async complete(id, status, body, completedAt, tx) {
    await (tx ?? db)
      .update(apiIdempotency)
      .set({
        state: "completed",
        responseStatus: status,
        responseBody: body,
        completedAt,
      })
      .where(eq(apiIdempotency.id, id))
  },
}

// Preflight the Idempotency-Key header before any work. executeIdempotent runs
// this too, so routes that derive credentials from the key can reject a missing
// or malformed key up front and reuse the same trimmed value.
export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key")?.trim()
  if (!(key && isUuid(key))) {
    throw new IdempotencyError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "A UUID Idempotency-Key is required"
    )
  }
  return key
}
