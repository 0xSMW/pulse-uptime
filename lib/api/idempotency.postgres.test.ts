import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { canonicalSerialize } from "@/lib/config/canonical";
import * as schema from "@/lib/db/schema";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("idempotency PostgreSQL atomicity", () => {
  const client = postgres(databaseUrl!, { max: 1, prepare: false });
  const verify = drizzle(client, { schema });

  let executeIdempotent: typeof import("./idempotency").executeIdempotent;
  let closeModuleConnection: () => Promise<void>;

  const newLease = (name: string) => ({
    name, ownerId: crypto.randomUUID(), leaseUntil: new Date(Date.now() + 60_000), updatedAt: new Date(),
  });
  const request = (key: string) =>
    new Request("https://pulse.example/api/v1/test", { method: "POST", headers: { "Idempotency-Key": key } });
  const findIdempotencyRecord = async (key: string) =>
    (await verify.select().from(schema.apiIdempotency).where(eq(schema.apiIdempotency.idempotencyKey, key)))[0];
  const findLease = async (name: string) =>
    (await verify.select().from(schema.jobLeases).where(eq(schema.jobLeases.name, name)))[0];

  beforeAll(async () => {
    const source = await readFile(resolve(process.cwd(), "drizzle", "0000_clumsy_lake.sql"), "utf8");
    for (const statement of source.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) {
      await client.unsafe(statement);
    }
    // The module under test binds its db client to DATABASE_URL at import
    // time, so the env var must point at the test database before the
    // dynamic import below evaluates lib/db/client.ts.
    process.env.DATABASE_URL = databaseUrl;
    ({ executeIdempotent } = await import("./idempotency"));
    const { sql } = await import("@/lib/db/client");
    closeModuleConnection = () => sql.end();
  }, 30_000);

  afterAll(async () => {
    await closeModuleConnection();
    await client.end();
  });

  it("commits the mutation and the idempotency completion together", async () => {
    const key = "00000000-0000-4000-8000-000000000010";
    const result = await executeIdempotent({
      request: request(key), principalKey: "human:1", routeKey: "test", body: { name: "atomic-lease" },
      work: async (context) => context.transaction(async (tx) => {
        await tx.insert(schema.jobLeases).values(newLease("atomic-lease"));
        return { status: 201, body: { ok: true } };
      }),
    });
    expect(result).toMatchObject({ status: 201, body: { ok: true }, replayed: false });
    expect(await findLease("atomic-lease")).toBeTruthy();
    expect(await findIdempotencyRecord(key)).toMatchObject({ state: "completed", responseStatus: 201, responseBody: { ok: true } });
  });

  it("rolls back the mutation and leaves the record running when run() throws", async () => {
    const key = "00000000-0000-4000-8000-000000000020";
    await expect(executeIdempotent({
      request: request(key), principalKey: "human:1", routeKey: "test", body: { name: "rollback-lease" },
      work: async (context) => context.transaction(async (tx) => {
        await tx.insert(schema.jobLeases).values(newLease("rollback-lease"));
        throw new Error("mutation failed");
      }),
    })).rejects.toThrow("mutation failed");
    expect(await findLease("rollback-lease")).toBeUndefined();
    const record = await findIdempotencyRecord(key);
    expect(record).toMatchObject({ state: "running", responseStatus: null, responseBody: null, completedAt: null });
  });

  it("commits a nested savepoint transaction along with the outer transaction", async () => {
    const seedName = "seed-nested-commit";
    await verify.insert(schema.jobLeases).values(newLease(seedName));
    const newOwner = crypto.randomUUID();
    const key = "00000000-0000-4000-8000-000000000030";
    const result = await executeIdempotent({
      request: request(key), principalKey: "human:1", routeKey: "test", body: { name: seedName },
      work: async (context) => context.transaction(async (tx) => {
        await tx.transaction(async (inner) => {
          await inner.select().from(schema.jobLeases).where(eq(schema.jobLeases.name, seedName)).for("update");
          await inner.update(schema.jobLeases).set({ ownerId: newOwner }).where(eq(schema.jobLeases.name, seedName));
        });
        return { status: 200, body: { ok: true } };
      }),
    });
    expect(result).toMatchObject({ status: 200, replayed: false });
    expect((await findLease(seedName))?.ownerId).toBe(newOwner);
    expect(await findIdempotencyRecord(key)).toMatchObject({ state: "completed" });
  });

  it("rolls back a committed nested savepoint when the outer transaction fails afterward", async () => {
    const seedName = "seed-nested-rollback";
    await verify.insert(schema.jobLeases).values(newLease(seedName));
    const originalOwner = (await findLease(seedName))!.ownerId;
    const key = "00000000-0000-4000-8000-000000000040";
    await expect(executeIdempotent({
      request: request(key), principalKey: "human:1", routeKey: "test", body: { name: seedName },
      work: async (context) => context.transaction(async (tx) => {
        await tx.transaction(async (inner) => {
          await inner.select().from(schema.jobLeases).where(eq(schema.jobLeases.name, seedName)).for("update");
          await inner.update(schema.jobLeases).set({ ownerId: crypto.randomUUID() }).where(eq(schema.jobLeases.name, seedName));
        });
        throw new Error("outer failed after nested commit");
      }),
    })).rejects.toThrow("outer failed after nested commit");
    expect((await findLease(seedName))?.ownerId).toBe(originalOwner);
    expect(await findIdempotencyRecord(key)).toMatchObject({ state: "running" });
  });

  it("replays the stored response for a repeated key without duplicating the mutation", async () => {
    const key = "00000000-0000-4000-8000-000000000050";
    const body = { name: "replay-lease" };
    const work = vi.fn(async (context: Parameters<Parameters<typeof executeIdempotent>[0]["work"]>[0]) =>
      context.transaction(async (tx) => {
        await tx.insert(schema.jobLeases).values(newLease("replay-lease"));
        return { status: 201, body: { ok: true } };
      }));

    const first = await executeIdempotent({ request: request(key), principalKey: "human:1", routeKey: "test", body, work });
    const second = await executeIdempotent({ request: request(key), principalKey: "human:1", routeKey: "test", body, work });

    expect(first).toMatchObject({ status: 201, body: { ok: true }, replayed: false });
    expect(second).toMatchObject({ status: 201, body: { ok: true }, replayed: true });
    expect(work).toHaveBeenCalledOnce();
    const leases = await verify.select().from(schema.jobLeases).where(eq(schema.jobLeases.name, "replay-lease"));
    expect(leases).toHaveLength(1);
  });

  it("replays a completed record past the stale window instead of reclaiming and rerunning it", async () => {
    const key = "00000000-0000-4000-8000-000000000060";
    const body = { name: "stale-completed-lease" };
    const staleRequest = request(key);
    const url = new URL(staleRequest.url);
    const requestHash = createHash("sha256")
      .update(`${staleRequest.method}\n${url.pathname}\n${canonicalSerialize(body)}`)
      .digest("hex");
    const id = crypto.randomUUID();
    const createdAt = new Date(Date.now() - 10 * 60_000); // past the 5 minute stale window

    // Insert as running, the way executeIdempotent's insertRunning would.
    await verify.insert(schema.apiIdempotency).values({
      id,
      principalKey: "human:1",
      idempotencyKey: key,
      method: staleRequest.method,
      routeKey: "test",
      requestHash,
      responseStatus: null,
      responseBody: null,
      state: "running",
      createdAt,
      completedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    // The original request finishes late, past the stale window, the way
    // persistence.complete() would. createdAt is left untouched, so an age
    // check alone would still consider this record claimable as stale.
    await verify.update(schema.apiIdempotency).set({
      state: "completed", responseStatus: 200, responseBody: { ok: true, value: "original" }, completedAt: new Date(),
    }).where(eq(schema.apiIdempotency.id, id));

    const work = vi.fn(async () => ({ status: 201, body: { ok: true, value: "reran" } }));
    const result = await executeIdempotent({
      request: request(key), principalKey: "human:1", routeKey: "test", body, work, now: new Date(),
    });

    expect(result).toMatchObject({ status: 200, body: { ok: true, value: "original" }, replayed: true });
    expect(work).not.toHaveBeenCalled();
    expect(await findIdempotencyRecord(key)).toMatchObject({
      state: "completed", responseStatus: 200, responseBody: { ok: true, value: "original" },
    });
  });
});
