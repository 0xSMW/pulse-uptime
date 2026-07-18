import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  acquireIdempotencyOwner,
  executeIdempotent,
  type IdempotencyPersistence,
  type IdempotencyRecord,
  reclaimExpiredRecord,
} from "./idempotency";

const key = "00000000-0000-4000-8000-000000000001";

class MemoryPersistence implements IdempotencyPersistence {
  owner: IdempotencyRecord | undefined;

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
    if (!this.owner || this.owner.id !== id || this.owner.createdAt >= staleBefore) return undefined;
    this.owner = { ...this.owner, createdAt: now, expiresAt };
    return id;
  }

  async complete(id: string, status: number, body: unknown, completedAt: Date) {
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

  it("atomically replaces an expired running owner", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const persistence = new MemoryPersistence(stored("running", now));
    const oldId = persistence.owner!.id;
    await executeIdempotent({ ...request({ value: "same" }), now, persistence, work: async () => ({ status: 200, body: { value: "recovered" } }) });
    expect(persistence.owner).toMatchObject({ state: "completed", responseBody: { value: "recovered" } });
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
