import { describe, expect, it } from "vitest";

import type { DatabaseHandle } from "@/lib/db/client";

import { hourBucket, systemAlertKey } from "./idempotency";
import { enqueueSystemAlert } from "./system-alert";

function fakeDb(resultRows: { id: string; recipient: string; idempotencyKey: string }[]) {
  const calls: { rows?: readonly Record<string, unknown>[] } = {};
  const db = {
    insert: () => ({
      values: (rows: readonly Record<string, unknown>[]) => {
        calls.rows = rows;
        return {
          onConflictDoNothing: () => ({
            returning: async () => resultRows,
          }),
        };
      },
    }),
  } as unknown as DatabaseHandle;
  return { db, calls };
}

describe("enqueueSystemAlert", () => {
  const now = new Date("2026-07-18T12:30:00.000Z");

  it("inserts one pending row per normalized recipient with immediate nextAttemptAt", async () => {
    const returning = [
      { id: "a", recipient: "ops@example.com", idempotencyKey: "k-ops" },
      { id: "b", recipient: "oncall@example.com", idempotencyKey: "k-oncall" },
    ];
    const { db, calls } = fakeDb(returning);
    const inserted = await enqueueSystemAlert(db, {
      kind: "monitoring-loop-failure",
      title: "Loop down",
      detail: "detail",
      reason: "stale",
      detectedAt: now,
      recipients: [" Ops@Example.COM ", "oncall@example.com", "ops@example.com"],
    }, { now, createId: () => `id-${(calls.rows?.length ?? 0) + Math.random()}` });

    expect(calls.rows).toHaveLength(2);
    expect(calls.rows?.map((row) => row.recipient).sort()).toEqual([
      "oncall@example.com",
      "ops@example.com",
    ]);
    for (const row of calls.rows ?? []) {
      expect(row).toMatchObject({
        eventType: "system.alert",
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: now,
      });
      expect(row.idempotencyKey).toBe(
        systemAlertKey("monitoring-loop-failure", hourBucket(now), String(row.recipient)),
      );
      expect(row.payload).toMatchObject({
        type: "system.alert",
        title: "Loop down",
        reason: "stale",
        detectedAt: now.toISOString(),
      });
    }
    expect(inserted).toEqual(returning.map((row) => ({
      id: row.id,
      recipient: row.recipient,
      idempotencyKey: row.idempotencyKey,
      payload: expect.objectContaining({ type: "system.alert" }),
    })));
  });

  it("returns no rows when every recipient conflicts or the list is empty", async () => {
    const empty = await enqueueSystemAlert(fakeDb([]).db, {
      kind: "monitoring-loop-failure",
      title: "t",
      detail: "d",
      reason: "stale",
      detectedAt: now,
      recipients: [],
    }, { now });
    expect(empty).toEqual([]);

    const { db, calls } = fakeDb([]);
    const conflicted = await enqueueSystemAlert(db, {
      kind: "monitoring-loop-failure",
      title: "t",
      detail: "d",
      reason: "stale",
      detectedAt: now,
      recipients: ["ops@example.com"],
    }, { now, createId: () => "id-1" });
    expect(calls.rows).toHaveLength(1);
    expect(conflicted).toEqual([]);
  });
});
