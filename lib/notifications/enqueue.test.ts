import { describe, expect, it, vi } from "vitest";

import type { DatabaseHandle } from "@/lib/db/client";

import {
  ENQUEUE_NOTIFICATION_SQL,
  buildEnqueueNotificationSql,
  enqueueDependencyNotifications,
  enqueueIncidentNotifications,
} from "./enqueue";
import type { SqlExecutor } from "./sql";

const baseOpenedInput = {
  event: "opened" as const,
  incidentId: "incident-1",
  monitorId: "api",
  monitorName: "Public API",
  startedAt: "now",
  cause: "timeout",
};

describe("incident notification enqueue", () => {
  it("returns 0 and issues no query when there are no recipients", async () => {
    const query = vi.fn(async () => []);
    const inserted = await enqueueIncidentNotifications({ query } as SqlExecutor, {
      ...baseOpenedInput,
      recipients: [],
    });
    expect(inserted).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("enqueues a single recipient with one insert statement", async () => {
    const query = vi.fn(async (text: string, values: readonly unknown[]) => {
      void text;
      void values;
      return [{ id: "inserted" }];
    });
    const inserted = await enqueueIncidentNotifications({ query } as SqlExecutor, {
      ...baseOpenedInput,
      recipients: ["ops@example.com"],
    }, {
      now: new Date("2026-07-18T00:00:00Z"),
      createId: () => "notification-1",
    });
    expect(inserted).toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toBe(ENQUEUE_NOTIFICATION_SQL);
    const values = query.mock.calls[0]?.[1];
    expect(values).toEqual([
      "notification-1",
      "incident-1",
      "api",
      "incident.opened",
      "ops@example.com",
      expect.stringMatching(/^incident\/incident-1\/opened\/[a-f0-9]{64}$/),
      expect.any(String),
      new Date("2026-07-18T00:00:00Z"),
    ]);
    const payloadParam = values?.[6];
    expect(typeof payloadParam).toBe("string");
    expect(JSON.parse(payloadParam as string)).toStrictEqual({
      type: "incident.opened",
      monitorName: "Public API",
      incidentId: "incident-1",
      startedAt: "now",
      cause: "timeout",
    });
  });

  it("deduplicates normalized duplicate input recipients and relies on the permanent key constraint", async () => {
    expect(ENQUEUE_NOTIFICATION_SQL).toMatch(/on conflict \(idempotency_key\) do nothing/i);
    const query = vi.fn(async (text: string, values: readonly unknown[]) => {
      void text;
      void values;
      return [{ id: "inserted" }];
    });
    const inserted = await enqueueIncidentNotifications({ query } as SqlExecutor, {
      ...baseOpenedInput,
      recipients: ["Ops@example.com", " ops@EXAMPLE.com "],
    }, {
      now: new Date("2026-07-18T00:00:00Z"),
      createId: () => "notification-1",
    });
    expect(inserted).toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
    const values = query.mock.calls[0]?.[1];
    expect(values?.[4]).toBe("ops@example.com");
    expect(values?.[5]).toMatch(/^incident\/incident-1\/opened\/[a-f0-9]{64}$/);
    expect(typeof values?.[6]).toBe("string");
    expect(JSON.parse(values?.[6] as string)).toMatchObject({ type: "incident.opened", incidentId: "incident-1" });
  });

  it("enqueues many distinct recipients with a single multi-row insert statement", async () => {
    const recipients = ["a@example.com", "b@example.com", "c@example.com", "d@example.com"];
    let idCounter = 0;
    const query = vi.fn(async (text: string, values: readonly unknown[]) => {
      void text;
      void values;
      return recipients.map(() => ({ id: `inserted-${idCounter++}` }));
    });
    const inserted = await enqueueIncidentNotifications({ query } as SqlExecutor, {
      ...baseOpenedInput,
      recipients,
    }, {
      now: new Date("2026-07-18T00:00:00Z"),
      createId: () => "generated-id",
    });

    expect(inserted).toBe(4);
    expect(query).toHaveBeenCalledTimes(1);

    const [text, values] = query.mock.calls[0]!;
    expect(text).toBe(buildEnqueueNotificationSql(4));
    expect(text.match(/on conflict \(idempotency_key\) do nothing/gi)).toHaveLength(1);
    // Each row uses eight values and references its timestamp three times.
    expect(text.match(/\$\d+/g)).toHaveLength(4 * 10);
    expect(values).toHaveLength(4 * 8);
    // The fifth value is the recipient.
    expect([values[4], values[12], values[20], values[28]]).toEqual(recipients);
    // The seventh value is a serialized JSON payload.
    const payloadParams = [values[6], values[14], values[22], values[30]];
    for (const payloadParam of payloadParams) {
      expect(typeof payloadParam).toBe("string");
      expect(JSON.parse(payloadParam as string)).toStrictEqual({
        type: "incident.opened",
        monitorName: "Public API",
        incidentId: "incident-1",
        startedAt: "now",
        cause: "timeout",
      });
    }
  });

  it("reports only the rows actually inserted when some idempotency keys conflict", async () => {
    const recipients = ["a@example.com", "b@example.com", "c@example.com"];
    const query = vi.fn(async () => [{ id: "kept-1" }, { id: "kept-2" }]);
    const inserted = await enqueueIncidentNotifications({ query } as SqlExecutor, {
      ...baseOpenedInput,
      recipients,
    }, {
      now: new Date("2026-07-18T00:00:00Z"),
      createId: () => "generated-id",
    });

    expect(inserted).toBe(2);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("builds distinct positional placeholders per row without reusing across recipients", () => {
    const sql = buildEnqueueNotificationSql(2);
    expect(sql).toContain(
      "($1, $2, $3, $4, $5, $6, $7, 'pending', 0, $8, $8, $8),\n" +
      "($9, $10, $11, $12, $13, $14, $15, 'pending', 0, $16, $16, $16)",
    );
    expect(sql).toMatch(/on conflict \(idempotency_key\) do nothing/i);
    expect(sql).toMatch(/returning id/i);
  });
});

const baseDependencyInput = {
  event: "incident" as const,
  sourceId: "vercel",
  incidentExternalId: "inc-1",
  presetId: "vercel_runtime",
  scopeId: null as string | null,
  dependencyId: "dep-1",
  dependencyName: "Vercel Runtime",
  provider: "Vercel",
  incidentTitle: "Elevated function errors",
  state: "OUTAGE",
  canonicalUrl: "https://www.vercel-status.com/incidents/inc-1",
  providerTimestamp: "2026-07-19T12:00:00.000Z",
};

// Fakes the Drizzle chain enqueueDependencyNotifications now runs on
// (db.insert(...).values(...).onConflictDoNothing(...).returning(...))
// instead of the raw SqlExecutor the incident-notification path above still
// uses. This is the same handle shape a transaction exposes, which is the
// point: persist.ts passes its tx here so the outbox insert joins whatever
// transaction the caller is already in.
function fakeDependencyDb(resultRows: { id: string }[] = [{ id: "inserted" }]) {
  const calls: { rows?: readonly Record<string, unknown>[]; target?: unknown } = {};
  const db = {
    insert: () => ({
      values: (rows: readonly Record<string, unknown>[]) => {
        calls.rows = rows;
        return {
          onConflictDoNothing: (options: { target: unknown }) => {
            calls.target = options.target;
            return { returning: async () => resultRows };
          },
        };
      },
    }),
  } as unknown as DatabaseHandle;
  return { db, calls };
}

describe("dependency notification enqueue", () => {
  it("returns 0 and issues no insert when there are no recipients", async () => {
    const { db, calls } = fakeDependencyDb();
    const inserted = await enqueueDependencyNotifications(db, {
      ...baseDependencyInput,
      recipients: [],
    });
    expect(inserted).toBe(0);
    expect(calls.rows).toBeUndefined();
  });

  it("enqueues a dependency incident with monitor_id and incident_id left unset", async () => {
    const { db, calls } = fakeDependencyDb();
    const inserted = await enqueueDependencyNotifications(db, {
      ...baseDependencyInput,
      recipients: ["ops@example.com"],
    }, { now: new Date("2026-07-19T12:00:00Z"), createId: () => "notification-1" });

    expect(inserted).toBe(1);
    expect(calls.rows).toHaveLength(1);
    const row = calls.rows![0]!;
    expect(row.monitorId).toBeUndefined();
    expect(row.incidentId).toBeUndefined();
    expect(row).toMatchObject({
      id: "notification-1",
      dependencyId: "dep-1",
      eventType: "dependency.incident",
      recipient: "ops@example.com",
      idempotencyKey: expect.stringMatching(/^dependency\/vercel\/inc-1\/vercel_runtime\/\/incident\/[a-f0-9]{64}$/),
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: new Date("2026-07-19T12:00:00Z"),
      createdAt: new Date("2026-07-19T12:00:00Z"),
      updatedAt: new Date("2026-07-19T12:00:00Z"),
    });
    expect(row.payload).toStrictEqual({
      type: "dependency.incident",
      dependencyName: "Vercel Runtime",
      provider: "Vercel",
      incidentTitle: "Elevated function errors",
      state: "OUTAGE",
      canonicalUrl: "https://www.vercel-status.com/incidents/inc-1",
      providerTimestamp: "2026-07-19T12:00:00.000Z",
    });
  });

  it("builds a dependency.recovery payload for the recovery event", async () => {
    const { db, calls } = fakeDependencyDb();
    await enqueueDependencyNotifications(db, {
      ...baseDependencyInput,
      event: "recovery",
      recipients: ["ops@example.com"],
    }, { now: new Date("2026-07-19T12:00:00Z"), createId: () => "notification-1" });
    const row = calls.rows![0]!;
    expect(row.idempotencyKey).toMatch(/^dependency\/vercel\/inc-1\/vercel_runtime\/\/recovery\//);
    expect((row.payload as { type: string }).type).toBe("dependency.recovery");
  });

  it("deduplicates normalized duplicate recipients", async () => {
    const { db, calls } = fakeDependencyDb();
    const inserted = await enqueueDependencyNotifications(db, {
      ...baseDependencyInput,
      recipients: ["Ops@example.com", " ops@EXAMPLE.com "],
    }, { now: new Date("2026-07-19T12:00:00Z"), createId: () => "notification-1" });
    expect(inserted).toBe(1);
    expect(calls.rows).toHaveLength(1);
  });

  it("relies on the idempotency key constraint to report only newly inserted rows", async () => {
    const recipients = ["a@example.com", "b@example.com", "c@example.com"];
    const { db, calls } = fakeDependencyDb([{ id: "kept-1" }]);
    const inserted = await enqueueDependencyNotifications(db, {
      ...baseDependencyInput,
      recipients,
    }, { now: new Date("2026-07-19T12:00:00Z"), createId: () => "generated-id" });
    expect(inserted).toBe(1);
    expect(calls.rows).toHaveLength(3);
  });

  it("targets the idempotency key column on conflict, one row per recipient", async () => {
    const { db, calls } = fakeDependencyDb();
    await enqueueDependencyNotifications(db, {
      ...baseDependencyInput,
      recipients: ["a@example.com", "b@example.com"],
    }, { now: new Date("2026-07-19T12:00:00Z"), createId: () => "generated-id" });
    expect(calls.rows).toHaveLength(2);
    expect(calls.target).toBeDefined();
  });

  it("gives two scoped installs of the same preset distinct idempotency keys (FIX C)", async () => {
    const us = fakeDependencyDb();
    await enqueueDependencyNotifications(us.db, {
      ...baseDependencyInput,
      scopeId: "us-east-1",
      recipients: ["ops@example.com"],
    }, { now: new Date("2026-07-19T12:00:00Z"), createId: () => "notification-1" });
    const usKey = us.calls.rows![0]!.idempotencyKey as string;

    const eu = fakeDependencyDb();
    await enqueueDependencyNotifications(eu.db, {
      ...baseDependencyInput,
      scopeId: "eu-west-2",
      recipients: ["ops@example.com"],
    }, { now: new Date("2026-07-19T12:00:00Z"), createId: () => "notification-2" });
    const euKey = eu.calls.rows![0]!.idempotencyKey as string;

    expect(usKey).not.toBe(euKey);
    expect(usKey).toContain("/us-east-1/");
    expect(euKey).toContain("/eu-west-2/");
  });
});
