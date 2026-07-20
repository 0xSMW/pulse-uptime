import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { DatabaseHandle } from "@/lib/db/client";

import {
  acquireIdempotencyOwner,
  ATOMIC_PROTOCOL,
  executeIdempotent,
  IdempotencyError,
  type IdempotencyPersistence,
  type IdempotencyRecord,
  LEGACY_PROTOCOL,
  reclaimExpiredRecord,
  requireIdempotencyKey,
} from "./idempotency";

const key = "00000000-0000-4000-8000-000000000001";
const stubTx = "stub-tx" as unknown as DatabaseHandle;

class MemoryPersistence implements IdempotencyPersistence {
  owner: IdempotencyRecord | undefined;
  completions: Array<{ id: string; status: number; body: unknown; usedTx: boolean }> = [];
  // Models the row lock lockOwner takes for the life of a transaction. An
  // entry is a promise a concurrent claimStale awaits, released when the
  // holder's transaction settles.
  private locks = new Map<string, Promise<void>>();
  private releasers: Array<() => void> = [];

  constructor(owner?: IdempotencyRecord) { this.owner = owner; }

  async insertRunning(value: Parameters<IdempotencyPersistence["insertRunning"]>[0]) {
    if (this.owner) return undefined;
    this.owner = { responseStatus: null, responseBody: null, completedAt: null, ...value } as IdempotencyRecord;
    return this.owner.id;
  }

  async findOwner(principalKey: string, idempotencyKey: string) {
    return this.owner?.principalKey === principalKey && this.owner.idempotencyKey === idempotencyKey ? this.owner : undefined;
  }

  async reclaimExpired(id: string, now: Date, value: Parameters<IdempotencyPersistence["reclaimExpired"]>[2]) {
    if (!this.owner || this.owner.id !== id || this.owner.expiresAt > now) return null;
    this.owner = { responseStatus: null, responseBody: null, completedAt: null, ...value } as IdempotencyRecord;
    return this.owner.id;
  }

  async claimStale(id: string, staleBefore: Date, now: Date, expiresAt: Date) {
    // A live owner holds a row lock for the life of its transaction, so this
    // claim waits for it to settle, mirroring the database FOR UPDATE lock.
    const held = this.locks.get(id);
    if (held) await held;
    // A completed record must never be reclaimed, mirroring the database
    // guard: complete() does not touch createdAt, so the age check alone
    // would still match a record whose owner finished just after it was
    // read as running. A legacy record from before the atomic protocol is
    // refused too, because its mutation could have committed before a
    // separate completion write failed.
    if (!this.owner || this.owner.id !== id || this.owner.state !== "running"
      || this.owner.protocol !== ATOMIC_PROTOCOL || this.owner.createdAt >= staleBefore) return undefined;
    this.owner = { ...this.owner, createdAt: now, expiresAt };
    return id;
  }

  async lockOwner(id: string, _tx: DatabaseHandle) {
    void _tx;
    // Install a lock for id that transaction() releases when the enclosing
    // transaction settles, so a concurrent claimStale blocks until then.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(id, held);
    this.releasers.push(() => { release(); this.locks.delete(id); });
  }

  async transaction<R>(run: (tx: DatabaseHandle) => Promise<R>) {
    // A real transaction rolls back everything, including the completion
    // write, when `run` throws. The fake mirrors that by only committing
    // owner/completion state after `run` resolves. Locks lockOwner took
    // during this transaction release when it settles either way.
    const mark = this.releasers.length;
    try {
      return await run(stubTx);
    } finally {
      while (this.releasers.length > mark) this.releasers.pop()!();
    }
  }

  async complete(id: string, status: number, body: unknown, completedAt: Date, tx?: DatabaseHandle) {
    this.completions.push({ id, status, body, usedTx: tx !== undefined });
    if (!this.owner || this.owner.id !== id) return;
    this.owner = { ...this.owner, state: "completed", responseStatus: status, responseBody: body, completedAt };
  }
}

function stored(state: "running" | "completed", expiresAt: Date): IdempotencyRecord {
  return {
    id: "00000000-0000-4000-8000-000000000099",
    principalKey: "human:1",
    idempotencyKey: key,
    method: "POST",
    routeKey: "test",
    requestHash: "old-request-hash",
    protocol: ATOMIC_PROTOCOL,
    responseStatus: state === "completed" ? 200 : null,
    responseBody: state === "completed" ? { value: "stale" } : null,
    state,
    createdAt: new Date(expiresAt.getTime() - 60_000),
    completedAt: state === "completed" ? new Date(expiresAt.getTime() - 1_000) : null,
    expiresAt,
  };
}

function request(body: unknown) {
  return {
    request: new Request("https://pulse.example/api/v1/test", { method: "POST", headers: { "Idempotency-Key": key } }),
    principalKey: "human:1",
    routeKey: "test",
    body,
  };
}

describe("requireIdempotencyKey", () => {
  function post(headers: Record<string, string>) {
    return new Request("https://pulse.example/api/v1/test", { method: "POST", headers });
  }

  it("returns the trimmed key for a strict UUID", () => {
    expect(requireIdempotencyKey(post({ "Idempotency-Key": `  ${key}  ` }))).toBe(key);
  });

  it("throws IDEMPOTENCY_KEY_REQUIRED when the header is absent", () => {
    expect(() => requireIdempotencyKey(post({}))).toThrow(IdempotencyError);
    try {
      requireIdempotencyKey(post({}));
    } catch (error) {
      expect((error as IdempotencyError).code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    }
  });

  it("rejects a loose-shaped but non-strict UUID", () => {
    // variant nibble 7 passes the loose 8-4-4-4-12 shape but fails the strict one.
    expect(() => requireIdempotencyKey(post({ "Idempotency-Key": "00000000-0000-4000-7000-000000000001" })))
      .toThrow(IdempotencyError);
  });
});

describe("idempotency retention reclamation", () => {
  it("executes a new operation for a different body after completed-row expiry", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const persistence = new MemoryPersistence(stored("completed", new Date(now.getTime() - 1)));
    const oldId = persistence.owner!.id;
    const work = vi.fn(async () => ({ status: 201, body: { value: "fresh" } }));
    const result = await executeIdempotent({ ...request({ value: "changed" }), now, persistence, work });
    expect(result).toMatchObject({ status: 201, body: { value: "fresh" }, replayed: false });
    expect(work).toHaveBeenCalledOnce();
    expect(persistence.owner?.id).not.toBe(oldId);
    expect(persistence.owner).toMatchObject({ state: "completed", responseBody: { value: "fresh" } });
    await persistence.complete(oldId, 200, { value: "late-old-worker" }, now);
    expect(persistence.owner?.responseBody).toEqual({ value: "fresh" });
  });

  it("reruns work() for an expired running owner instead of trying to recover", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const persistence = new MemoryPersistence(stored("running", now));
    const oldId = persistence.owner!.id;
    await executeIdempotent({ ...request({ value: "same" }), now, persistence, work: async () => ({ status: 200, body: { value: "reran" } }) });
    expect(persistence.owner).toMatchObject({ state: "completed", responseBody: { value: "reran" } });
    expect(persistence.owner?.id).not.toBe(oldId);
  });

  it("makes a boundary loser observe the replacement owner", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const persistence = new MemoryPersistence(stored("running", now));
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const winner = executeIdempotent({
      ...request({ value: "same" }), now, persistence,
      work: async () => { started(); await gate; return { status: 200, body: { value: "winner" } }; },
    });
    await startedPromise;
    const loser = executeIdempotent({
      ...request({ value: "same" }), now, persistence,
      work: async () => ({ status: 200, body: { value: "loser" } }),
    });
    await expect(loser).rejects.toMatchObject({ code: "REQUEST_IN_PROGRESS" });
    release();
    await expect(winner).resolves.toMatchObject({ body: { value: "winner" } });
  });

  it("reclaims a completed row after expiry for a new operation", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const attempt = vi.fn(async () => "new-operation");
    const claimed = await reclaimExpiredRecord(
      { id: "completed-operation", state: "completed", expiresAt: new Date(now.getTime() - 1) },
      now,
      attempt,
    );
    expect(claimed).toBe("new-operation");
    expect(attempt).toHaveBeenCalledWith("completed-operation");
  });

  it("reclaims an expired running row", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const claimed = await reclaimExpiredRecord(
      { id: "abandoned-operation", state: "running", expiresAt: now },
      now,
      async () => "replacement-operation",
    );
    expect(claimed).toBe("replacement-operation");
  });

  it("allows only one owner at the concurrent expiry boundary", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    let owned = false;
    const atomicAttempt = async () => {
      if (owned) return null;
      owned = true;
      return "boundary-owner";
    };
    const results = await Promise.all([
      reclaimExpiredRecord({ id: "expired-operation", state: "running", expiresAt: now }, now, atomicAttempt),
      reclaimExpiredRecord({ id: "expired-operation", state: "running", expiresAt: now }, now, atomicAttempt),
    ]);
    expect(results.filter(Boolean)).toEqual(["boundary-owner"]);
  });

  it("does not reclaim a row before its expiry boundary", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const attempt = vi.fn(async () => "stolen-operation");
    expect(await reclaimExpiredRecord(
      { id: "active-operation", state: "completed", expiresAt: new Date(now.getTime() + 1) },
      now,
      attempt,
    )).toBeNull();
    expect(attempt).not.toHaveBeenCalled();
  });

  it("does not reclaim a record that completes between the stale read and the claim", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const persistence = new MemoryPersistence();
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });

    // The original request is slow: it inserts the running record, then
    // hangs in work() past what a retry will treat as the stale window.
    const original = executeIdempotent({
      ...request({ value: "same" }), now, persistence,
      work: async () => { started(); await gate; return { status: 200, body: { value: "original" } }; },
    });
    await startedPromise;

    // The retry reads the record as running-but-stale, but the original
    // finishes and completes it right after that read, before the retry's
    // claimStale runs. findOwner is where the fake can observe and react
    // to that read, so it releases the original there.
    const originalFindOwner = persistence.findOwner.bind(persistence);
    let released = false;
    persistence.findOwner = async (principalKey: string, idempotencyKey: string) => {
      const record = await originalFindOwner(principalKey, idempotencyKey);
      if (record && !released) {
        released = true;
        release();
        await original;
      }
      return record;
    };

    const retryNow = new Date(now.getTime() + 6 * 60_000); // past the 5 minute stale window
    const work = vi.fn(async () => ({ status: 200, body: { value: "reran" } }));
    await expect(executeIdempotent({ ...request({ value: "same" }), now: retryNow, persistence, work }))
      .rejects.toMatchObject({ code: "REQUEST_IN_PROGRESS" });
    expect(work).not.toHaveBeenCalled();
    expect(persistence.owner).toMatchObject({ state: "completed", responseBody: { value: "original" } });
  });

  it("retries insertion when maintenance deletes an expired row before reclaim", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    type Record = { id: string; state: "running"; expiresAt: Date };
    let owner: Record | undefined = { id: "expired-owner", state: "running", expiresAt: new Date(now.getTime() - 1) };
    let insertCount = 0;
    const acquired = await acquireIdempotencyOwner<Record>({
      now,
      insert: async () => {
        insertCount += 1;
        if (owner) return null;
        owner = { id: "new-owner", state: "running", expiresAt: new Date(now.getTime() + 60_000) };
        return owner.id;
      },
      find: async () => owner,
      reclaim: async () => {
        owner = undefined;
        return null;
      },
    });
    expect(acquired).toEqual({ recordId: "new-owner" });
    expect(insertCount).toBe(2);
  });
});

describe("atomic completion via context.transaction", () => {
  it("persists completion with the transaction handle when work uses context.transaction", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const persistence = new MemoryPersistence();
    const result = await executeIdempotent({
      ...request({ value: "same" }), now, persistence,
      work: async (context) => context.transaction(async (tx) => {
        expect(tx).toBe(stubTx);
        return { status: 201, body: { value: "atomic" } };
      }),
    });
    expect(result).toMatchObject({ status: 201, body: { value: "atomic" }, replayed: false });
    expect(persistence.completions).toEqual([{ id: persistence.owner!.id, status: 201, body: { value: "atomic" }, usedTx: true }]);
    expect(persistence.owner).toMatchObject({ state: "completed", responseStatus: 201, responseBody: { value: "atomic" } });
  });

  it("applies persistBody to the transaction-completion path too", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const persistence = new MemoryPersistence();
    await executeIdempotent({
      ...request({ value: "same" }), now, persistence,
      work: async (context) => context.transaction(async () => ({ status: 201, body: { secret: "raw", value: "kept" } })),
      persistBody: (body: { secret: string; value: string }) => ({ value: body.value }),
    });
    expect(persistence.completions[0]).toMatchObject({ body: { value: "kept" } });
  });

  it("falls back to a post-hoc completion write when work never calls context.transaction", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const persistence = new MemoryPersistence();
    await executeIdempotent({
      ...request({ value: "same" }), now, persistence,
      work: async () => ({ status: 200, body: { value: "no-mutation" } }),
    });
    expect(persistence.completions).toEqual([{ id: persistence.owner!.id, status: 200, body: { value: "no-mutation" }, usedTx: false }]);
  });

  it("throws when context.transaction is called more than once", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const persistence = new MemoryPersistence();
    await expect(executeIdempotent({
      ...request({ value: "same" }), now, persistence,
      work: async (context) => {
        await context.transaction(async () => ({ status: 200, body: { value: "first" } }));
        return context.transaction(async () => ({ status: 200, body: { value: "second" } }));
      },
    })).rejects.toThrow("context.transaction can only be called once per idempotent execution");
  });

  it("leaves the record running with no completion when run() throws", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const persistence = new MemoryPersistence();
    await expect(executeIdempotent({
      ...request({ value: "same" }), now, persistence,
      work: async (context) => context.transaction(async () => {
        throw new Error("mutation failed");
      }),
    })).rejects.toThrow("mutation failed");
    expect(persistence.completions).toEqual([]);
    expect(persistence.owner).toMatchObject({ state: "running", responseStatus: null, responseBody: null });
  });
});

describe("owner record locking guards a live in-flight owner from concurrent rerun", () => {
  it("locks the owner record before running the mutation on the transaction path", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const persistence = new MemoryPersistence();
    const order: string[] = [];
    const originalLock = persistence.lockOwner.bind(persistence);
    persistence.lockOwner = async (id: string, tx: DatabaseHandle) => {
      order.push("lock");
      return originalLock(id, tx);
    };
    await executeIdempotent({
      ...request({ value: "same" }), now, persistence,
      work: async (context) => context.transaction(async () => {
        order.push("run");
        return { status: 201, body: { value: "atomic" } };
      }),
    });
    expect(order).toEqual(["lock", "run"]);
  });

  it("blocks a stale claim while a live atomic owner holds its record lock, then reports in progress after the owner commits", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const persistence = new MemoryPersistence();
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });

    // The original owner opens its mutation transaction, takes the record
    // lock, and hangs in run() past the stale window a retry will apply.
    const winner = executeIdempotent({
      ...request({ value: "same" }), now, persistence,
      work: async (context) => context.transaction(async () => {
        started();
        await gate;
        return { status: 200, body: { value: "winner" } };
      }),
    });
    await startedPromise;

    // The retry reads the record as running-but-stale and calls claimStale
    // while the owner is still in flight. Without the lock, claimStale would
    // steal a still-running record and run the mutation a second time. With
    // it, claimStale blocks until the owner's transaction settles.
    const originalClaimStale = persistence.claimStale.bind(persistence);
    let claimEntered!: () => void;
    const claimEnteredPromise = new Promise<void>((resolve) => { claimEntered = resolve; });
    persistence.claimStale = async (...args: Parameters<IdempotencyPersistence["claimStale"]>) => {
      claimEntered();
      return originalClaimStale(...args);
    };

    const retryNow = new Date(now.getTime() + 6 * 60_000); // past the 5 minute stale window
    const work = vi.fn(async () => ({ status: 200, body: { value: "reran" } }));
    const loser = executeIdempotent({ ...request({ value: "same" }), now: retryNow, persistence, work });
    await claimEnteredPromise;
    release();

    await expect(loser).rejects.toMatchObject({ code: "REQUEST_IN_PROGRESS" });
    expect(work).not.toHaveBeenCalled();
    await expect(winner).resolves.toMatchObject({ body: { value: "winner" } });
    expect(persistence.owner).toMatchObject({ state: "completed", responseBody: { value: "winner" } });
  });

  it("reclaims and reruns an atomic running record past the stale window when the owner rolled back", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const persistence = new MemoryPersistence();
    // The original owner opened a transaction whose mutation threw, so the
    // record is still running under the atomic protocol and nothing committed.
    await expect(executeIdempotent({
      ...request({ value: "same" }), now, persistence,
      work: async (context) => context.transaction(async () => { throw new Error("left running"); }),
    })).rejects.toThrow("left running");
    persistence.owner = { ...persistence.owner!, createdAt: new Date(now.getTime() - 10 * 60_000) };

    const work = vi.fn(async () => ({ status: 200, body: { value: "reran" } }));
    const result = await executeIdempotent({ ...request({ value: "same" }), now: new Date(now.getTime() + 1), persistence, work });
    expect(result).toMatchObject({ status: 200, body: { value: "reran" }, replayed: false });
    expect(work).toHaveBeenCalledOnce();
    expect(persistence.owner).toMatchObject({ state: "completed", protocol: ATOMIC_PROTOCOL, responseBody: { value: "reran" } });
  });
});

describe("legacy records from before the atomic protocol are never rerun", () => {
  it("refuses to reclaim a legacy running record past the stale window and reports it in progress", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const persistence = new MemoryPersistence();
    // Seed a running record with a matching requestHash, then downgrade it to
    // the legacy protocol and age it past the stale window, the shape a
    // pre-atomic deploy leaves behind when its mutation committed but the
    // separate completion write failed.
    await expect(executeIdempotent({
      ...request({ value: "same" }), now, persistence,
      work: async (context) => context.transaction(async () => { throw new Error("left running"); }),
    })).rejects.toThrow("left running");
    persistence.owner = {
      ...persistence.owner!,
      protocol: LEGACY_PROTOCOL,
      createdAt: new Date(now.getTime() - 10 * 60_000),
    };

    const work = vi.fn(async () => ({ status: 200, body: { value: "reran" } }));
    await expect(executeIdempotent({ ...request({ value: "same" }), now: new Date(now.getTime() + 1), persistence, work }))
      .rejects.toMatchObject({ code: "REQUEST_IN_PROGRESS" });
    expect(work).not.toHaveBeenCalled();
    expect(persistence.owner).toMatchObject({ state: "running", protocol: LEGACY_PROTOCOL });
  });
});

/**
 * executeIdempotent fingerprints ONLY the `body` value a caller passes in
 * (folded into requestHash together with method/path/query). A route with an
 * additional precondition beyond the request document (e.g. status-page-config
 * PUT's If-Match) must fold that
 * precondition into `body` itself, or a client that reuses the same
 * Idempotency-Key with the SAME document but a FRESH precondition (re-read
 * after a 412, then resubmitted under the same key) would hash identically
 * to the first attempt and replay its stale stored response instead of being
 * evaluated fresh. These tests exercise executeIdempotent directly with a
 * `body` shaped exactly like that route's `{ ifMatch, document }` composite.
 */
describe("idempotency fingerprint covers whatever the caller passes as `body`, including a folded-in precondition", () => {
  function preconditionedRequest(ifMatch: string, document: unknown) {
    return {
      request: new Request("https://pulse.example/api/v1/status-page-config", {
        method: "PUT",
        headers: { "Idempotency-Key": key },
      }),
      principalKey: "human:1",
      routeKey: "/api/v1/status-page-config",
      body: { ifMatch, document },
    };
  }

  it("replays the stored response for a transport-level retry that resends the SAME key, If-Match, and document", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const persistence = new MemoryPersistence();
    const work = vi.fn(async () => ({ status: 200, body: { version: 6 } }));

    const first = await executeIdempotent({ ...preconditionedRequest('"5"', { name: "Acme Status" }), now, persistence, work });
    expect(first).toMatchObject({ status: 200, body: { version: 6 }, replayed: false });

    const retry = await executeIdempotent({ ...preconditionedRequest('"5"', { name: "Acme Status" }), now, persistence, work });
    expect(retry).toMatchObject({ status: 200, body: { version: 6 }, replayed: true });
    expect(work).toHaveBeenCalledOnce();
  });

  it("throws IDEMPOTENCY_KEY_REUSED for the SAME document resubmitted under the SAME key with a FRESH If-Match, instead of replaying the first attempt's response", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const persistence = new MemoryPersistence();
    const work = vi.fn(async () => ({ status: 200, body: { version: 6 } }));

    await executeIdempotent({ ...preconditionedRequest('"5"', { name: "Acme Status" }), now, persistence, work });

    await expect(executeIdempotent({
      ...preconditionedRequest('"6"', { name: "Acme Status" }), now, persistence, work,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    // The second call never reached work() again. It was rejected before
    // that point, which is the whole point: it must not silently replay OR
    // silently rerun, only surface the explicit "mint a new key" signal.
    expect(work).toHaveBeenCalledOnce();
  });
});
