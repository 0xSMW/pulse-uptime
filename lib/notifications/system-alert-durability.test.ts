import { describe, expect, it, vi } from "vitest";

import type { DatabaseHandle } from "@/lib/db/client";

import { deliverPendingNotifications, retryAt } from "./delivery";
import { hourBucket, normalizeRecipient, systemAlertKey } from "./idempotency";
import { NotificationProviderError, type NotificationSender } from "./provider";
import {
  CLAIM_NOTIFICATIONS_BY_EVENT_TYPE_SQL,
  CLAIM_NOTIFICATIONS_SQL,
  MARK_NOTIFICATION_FAILED_SQL,
  MARK_NOTIFICATION_SENT_SQL,
  PROVIDER_IDEMPOTENCY_RETRY_MARGIN_MS,
  PROVIDER_IDEMPOTENCY_WINDOW_MS,
  RECONCILE_STALE_CLAIMS_BY_EVENT_TYPE_SQL,
  claimNotifications,
  markNotificationSent,
  reconcileStaleClaims,
  type SqlExecutor,
} from "./sql";
import { enqueueSystemAlert } from "./system-alert";
import type { NotificationEventType, NotificationPayload, SystemAlertPayload } from "./types";

type OutboxStatus = "pending" | "sending" | "failed" | "sent" | "dead";

type OutboxRow = {
  id: string;
  incidentId: string | null;
  monitorId: string | null;
  dependencyId: string | null;
  eventType: NotificationEventType;
  recipient: string;
  idempotencyKey: string;
  payload: NotificationPayload;
  status: OutboxStatus;
  attemptCount: number;
  nextAttemptAt: Date;
  claimToken: string | null;
  claimedAt: Date | null;
  lastError: string | null;
  providerMessageId: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const SYSTEM_ALERT_PAYLOAD: SystemAlertPayload = {
  type: "system.alert",
  title: "Pulse monitoring loop is not running",
  detail: "detail",
  reason: "stale",
  detectedAt: "2026-07-18T12:00:00.000Z",
};

function systemRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  const now = overrides.createdAt ?? new Date("2026-07-18T12:00:00.000Z");
  return {
    id: "system-alert-1",
    incidentId: null,
    monitorId: null,
    dependencyId: null,
    eventType: "system.alert",
    recipient: "ops@example.com",
    idempotencyKey: systemAlertKey("monitoring-loop-failure", hourBucket(now), "ops@example.com"),
    payload: SYSTEM_ALERT_PAYLOAD,
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: now,
    claimToken: null,
    claimedAt: null,
    lastError: null,
    providerMessageId: null,
    sentAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * In-memory outbox that implements the claim / finalize / reconcile SQL paths
 * the production code issues. Enough fidelity to prove durability races without
 * a live Postgres.
 */
function createMemoryOutbox(seed: OutboxRow[] = []) {
  const rows = new Map<string, OutboxRow>(seed.map((row) => [row.id, { ...row }]));

  const db: SqlExecutor = {
    async query<T>(text: string, values: readonly unknown[]): Promise<readonly T[]> {
      if (text === CLAIM_NOTIFICATIONS_SQL || text === CLAIM_NOTIFICATIONS_BY_EVENT_TYPE_SQL) {
        const now = values[0] as Date;
        const limit = values[1] as number;
        const claimToken = values[2] as string;
        const eventTypes = text === CLAIM_NOTIFICATIONS_BY_EVENT_TYPE_SQL
          ? new Set(values[3] as string[])
          : null;

        const due = [...rows.values()]
          .filter((row) => {
            if (row.status !== "pending" && row.status !== "failed") return false;
            if (row.nextAttemptAt.getTime() > now.getTime()) return false;
            if (eventTypes && !eventTypes.has(row.eventType)) return false;
            return true;
          })
          .sort((a, b) => {
            const byAttempt = a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime();
            if (byAttempt !== 0) return byAttempt;
            const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
            if (byCreated !== 0) return byCreated;
            return a.id.localeCompare(b.id);
          })
          .slice(0, limit);

        // FOR UPDATE SKIP LOCKED: rows already in 'sending' are not due, so a
        // second concurrent claim of the same id is impossible once claimed.
        const claimed = due.map((row) => {
          const next: OutboxRow = {
            ...row,
            status: "sending",
            attemptCount: row.attemptCount + 1,
            claimToken,
            claimedAt: now,
            updatedAt: now,
          };
          rows.set(row.id, next);
          return {
            id: next.id,
            incident_id: next.incidentId,
            monitor_id: next.monitorId,
            dependency_id: next.dependencyId,
            event_type: next.eventType,
            recipient: next.recipient,
            idempotency_key: next.idempotencyKey,
            payload: next.payload,
            attempt_count: next.attemptCount,
            claim_token: next.claimToken,
          };
        });
        return claimed as T[];
      }

      if (text === MARK_NOTIFICATION_SENT_SQL) {
        const id = values[0] as string;
        const claimToken = values[1] as string;
        const providerMessageId = values[2] as string;
        const now = values[3] as Date;
        const row = rows.get(id);
        if (!row || row.status !== "sending" || row.claimToken !== claimToken) {
          return [] as T[];
        }
        rows.set(id, {
          ...row,
          status: "sent",
          providerMessageId,
          sentAt: now,
          claimToken: null,
          claimedAt: null,
          lastError: null,
          updatedAt: now,
        });
        return [{ id }] as T[];
      }

      if (text === MARK_NOTIFICATION_FAILED_SQL) {
        const id = values[0] as string;
        const claimToken = values[1] as string;
        const status = values[2] as "failed" | "dead";
        const nextAttemptAt = values[3] as Date;
        const lastError = values[4] as string;
        const now = values[5] as Date;
        const row = rows.get(id);
        if (!row || row.status !== "sending" || row.claimToken !== claimToken) {
          return [] as T[];
        }
        rows.set(id, {
          ...row,
          status,
          nextAttemptAt,
          claimToken: null,
          claimedAt: null,
          lastError,
          updatedAt: now,
        });
        return [{ id }] as T[];
      }

      if (
        text === RECONCILE_STALE_CLAIMS_BY_EVENT_TYPE_SQL
        || text.includes("where status = 'sending'")
      ) {
        const now = values[0] as Date;
        const cutoff = values[1] as Date;
        const safeRetryCutoff = values[2] as Date;
        const eventTypes = text === RECONCILE_STALE_CLAIMS_BY_EVENT_TYPE_SQL
          ? new Set(values[3] as string[])
          : null;
        const updated: { id: string; status: "failed" | "dead" }[] = [];
        for (const row of rows.values()) {
          if (row.status !== "sending" || !row.claimedAt) continue;
          if (row.claimedAt.getTime() >= cutoff.getTime()) continue;
          if (eventTypes && !eventTypes.has(row.eventType)) continue;
          const status: "failed" | "dead" =
            row.claimedAt.getTime() <= safeRetryCutoff.getTime() ? "dead" : "failed";
          rows.set(row.id, {
            ...row,
            status,
            nextAttemptAt: now,
            claimToken: null,
            claimedAt: null,
            lastError: status === "dead" ? "AMBIGUOUS_PROVIDER_RESULT" : "STALE_CLAIM",
            updatedAt: now,
          });
          updated.push({ id: row.id, status });
        }
        return updated as T[];
      }

      throw new Error(`Unexpected SQL in memory outbox: ${text.slice(0, 80)}`);
    },
  };

  return {
    db,
    rows,
    get(id: string) {
      return rows.get(id);
    },
    seed(row: OutboxRow) {
      rows.set(row.id, { ...row });
    },
  };
}

function fakeEnqueueDb(existingKeys: Set<string> = new Set()) {
  const inserted: OutboxRow[] = [];
  const calls: { rows?: readonly Record<string, unknown>[] } = {};
  const db = {
    insert: () => ({
      values: (rows: readonly Record<string, unknown>[]) => {
        calls.rows = rows;
        return {
          onConflictDoNothing: () => ({
            returning: async () => {
              const kept = rows.filter((row) => {
                const key = String(row.idempotencyKey);
                if (existingKeys.has(key)) return false;
                existingKeys.add(key);
                inserted.push({
                  id: String(row.id),
                  incidentId: null,
                  monitorId: null,
                  dependencyId: null,
                  eventType: row.eventType as NotificationEventType,
                  recipient: String(row.recipient),
                  idempotencyKey: key,
                  payload: row.payload as NotificationPayload,
                  status: "pending",
                  attemptCount: 0,
                  nextAttemptAt: row.nextAttemptAt as Date,
                  claimToken: null,
                  claimedAt: null,
                  lastError: null,
                  providerMessageId: null,
                  sentAt: null,
                  createdAt: row.createdAt as Date,
                  updatedAt: row.updatedAt as Date,
                });
                return true;
              });
              return kept.map((row) => ({
                id: String(row.id),
                recipient: String(row.recipient),
                idempotencyKey: String(row.idempotencyKey),
              }));
            },
          }),
        };
      },
    }),
  } as unknown as DatabaseHandle;
  return { db, calls, inserted, existingKeys };
}

describe("system.alert durability", () => {
  const hour = new Date("2026-07-18T12:05:00.000Z");

  it("marks a Resend failure failed with the retry ladder nextAttemptAt", async () => {
    const store = createMemoryOutbox([systemRow({ nextAttemptAt: hour, createdAt: hour })]);
    const sender: NotificationSender = {
      async send() {
        throw new NotificationProviderError("rate_limit_exceeded", true);
      },
    };

    const result = await deliverPendingNotifications({
      db: store.db,
      sender,
      appUrl: "https://pulse.example.com",
      now: () => hour,
      createClaimToken: () => "claim-1",
    }, { eventTypes: ["system.alert"] });

    expect(result).toEqual({ claimed: 1, sent: 0, failed: 1, dead: 0, lostClaims: 0 });
    const row = store.get("system-alert-1")!;
    expect(row.status).toBe("failed");
    expect(row.attemptCount).toBe(1);
    expect(row.claimToken).toBeNull();
    expect(row.lastError).toBe("rate_limit_exceeded");
    expect(row.nextAttemptAt).toEqual(retryAt(hour, 1));
  });

  it("later sweep same hour: enqueue inserts 0 and the failed row is claimed and retried", async () => {
    const failedAt = new Date("2026-07-18T12:00:00.000Z");
    const retryReady = retryAt(failedAt, 1);
    const sweepNow = new Date(retryReady.getTime() + 1_000);
    // Same UTC hour bucket as the original enqueue.
    expect(hourBucket(sweepNow)).toBe(hourBucket(failedAt));

    const existing = systemRow({
      status: "failed",
      attemptCount: 1,
      nextAttemptAt: retryReady,
      lastError: "rate_limit_exceeded",
      createdAt: failedAt,
      updatedAt: failedAt,
    });
    const store = createMemoryOutbox([existing]);

    const { db: enqueueDb, inserted } = fakeEnqueueDb(new Set([existing.idempotencyKey]));
    const enqueued = await enqueueSystemAlert(enqueueDb, {
      kind: "monitoring-loop-failure",
      title: SYSTEM_ALERT_PAYLOAD.title,
      detail: SYSTEM_ALERT_PAYLOAD.detail,
      reason: "stale",
      detectedAt: sweepNow,
      recipients: ["ops@example.com"],
    }, { now: sweepNow, createId: () => "should-not-insert" });
    expect(enqueued).toHaveLength(0);
    expect(inserted).toHaveLength(0);

    const send = vi.fn(async () => ({ providerMessageId: "email-retry-1" }));
    const delivery = await deliverPendingNotifications({
      db: store.db,
      sender: { send },
      appUrl: "https://pulse.example.com",
      now: () => sweepNow,
      createClaimToken: () => "claim-retry",
    }, { eventTypes: ["system.alert"] });

    expect(delivery).toEqual({ claimed: 1, sent: 1, failed: 0, dead: 0, lostClaims: 0 });
    expect(send).toHaveBeenCalledOnce();
    expect(store.get("system-alert-1")).toMatchObject({
      status: "sent",
      attemptCount: 2,
      providerMessageId: "email-retry-1",
    });
  });

  it("sweep vs ordinary outbox drainer race: only one consumer claims a row", async () => {
    const store = createMemoryOutbox([systemRow({ nextAttemptAt: hour, createdAt: hour })]);

    const [sweepClaim, ordinaryClaim] = await Promise.all([
      claimNotifications(store.db, {
        now: hour,
        limit: 50,
        claimToken: "sweep-token",
        eventTypes: ["system.alert"],
      }),
      claimNotifications(store.db, {
        now: hour,
        limit: 50,
        claimToken: "ordinary-token",
      }),
    ]);

    const claimedIds = [...sweepClaim, ...ordinaryClaim].map((row) => row.id);
    expect(claimedIds).toEqual(["system-alert-1"]);
    expect(sweepClaim.length + ordinaryClaim.length).toBe(1);
    expect(store.get("system-alert-1")?.status).toBe("sending");
    expect(
      store.get("system-alert-1")?.claimToken === "sweep-token"
      || store.get("system-alert-1")?.claimToken === "ordinary-token",
    ).toBe(true);
  });

  it("provider succeeds but persistence loses the claim: lostClaims increments, sent stays 0", async () => {
    const store = createMemoryOutbox([systemRow({ nextAttemptAt: hour, createdAt: hour })]);
    const send = vi.fn(async () => ({ providerMessageId: "email-orphan" }));

    // After send, another reconcilation/worker steals the claim token so the
    // mark-sent guard sees a mismatch and reports a lost claim.
    const originalMarkSent = markNotificationSent;
    const spyDb: SqlExecutor = {
      async query<T>(text: string, values: readonly unknown[]): Promise<readonly T[]> {
        if (text === MARK_NOTIFICATION_SENT_SQL) {
          const row = store.get(values[0] as string);
          if (row) {
            store.seed({
              ...row,
              claimToken: "stolen-by-reconcile",
              status: "sending",
            });
          }
        }
        return store.db.query<T>(text, values);
      },
    };

    const result = await deliverPendingNotifications({
      db: spyDb,
      sender: { send },
      appUrl: "https://pulse.example.com",
      now: () => hour,
      createClaimToken: () => "claim-lost",
    }, { eventTypes: ["system.alert"] });

    expect(send).toHaveBeenCalledOnce();
    expect(result.lostClaims).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    // Prove the real guard is the claim token, not a mock short-circuit.
    await expect(originalMarkSent(
      store.db,
      { id: "system-alert-1", claimToken: "claim-lost" },
      "email-orphan",
      hour,
    )).resolves.toBe(false);
  });

  it("process dies with system.alert in sending: later sweep reconciles and retries", async () => {
    const claimedAt = new Date("2026-07-18T12:00:00.000Z");
    const later = new Date(claimedAt.getTime() + 6 * 60_000);
    const store = createMemoryOutbox([systemRow({
      status: "sending",
      attemptCount: 1,
      claimToken: "dead-process-token",
      claimedAt,
      nextAttemptAt: claimedAt,
      createdAt: claimedAt,
      updatedAt: claimedAt,
    })]);

    const reconciled = await reconcileStaleClaims(store.db, later, 5 * 60_000, {
      eventTypes: ["system.alert"],
    });
    expect(reconciled).toBe(1);
    expect(store.get("system-alert-1")).toMatchObject({
      status: "failed",
      claimToken: null,
      claimedAt: null,
      lastError: "STALE_CLAIM",
      nextAttemptAt: later,
    });

    // Outside the provider idempotency window the row would be dead instead.
    const ancient = new Date(
      claimedAt.getTime()
      + (PROVIDER_IDEMPOTENCY_WINDOW_MS - PROVIDER_IDEMPOTENCY_RETRY_MARGIN_MS)
      + 1_000,
    );
    store.seed(systemRow({
      id: "system-alert-ancient",
      status: "sending",
      attemptCount: 1,
      claimToken: "ancient-token",
      claimedAt,
      nextAttemptAt: claimedAt,
      createdAt: claimedAt,
      updatedAt: claimedAt,
      idempotencyKey: "system/ancient",
    }));
    const deadCount = await reconcileStaleClaims(store.db, ancient, 5 * 60_000, {
      eventTypes: ["system.alert"],
    });
    expect(deadCount).toBe(1);
    expect(store.get("system-alert-ancient")?.status).toBe("dead");

    // Failed row from the first reconcile is due and can be claimed for retry.
    const send = vi.fn(async () => ({ providerMessageId: "email-after-crash" }));
    const delivery = await deliverPendingNotifications({
      db: store.db,
      sender: { send },
      appUrl: "https://pulse.example.com",
      now: () => later,
      createClaimToken: () => "claim-after-reconcile",
    }, { eventTypes: ["system.alert"], limit: 50 });

    expect(delivery.claimed).toBe(1);
    expect(delivery.sent).toBe(1);
    expect(store.get("system-alert-1")?.status).toBe("sent");
  });

  it("repeated unhealthy sweeps in one hour yield one outbox row per normalized recipient", async () => {
    const keys = new Set<string>();
    const { db, inserted } = fakeEnqueueDb(keys);
    const recipients = [" Ops@Example.COM ", "ops@example.com", "oncall@example.com"];
    const first = await enqueueSystemAlert(db, {
      kind: "monitoring-loop-failure",
      title: "title",
      detail: "detail",
      reason: "consecutive-failures",
      detectedAt: hour,
      recipients,
    }, {
      now: hour,
      createId: () => `id-${inserted.length + 1}`,
    });
    expect(first.map((row) => row.recipient).sort()).toEqual([
      "oncall@example.com",
      "ops@example.com",
    ]);
    expect(first).toHaveLength(2);

    const second = await enqueueSystemAlert(db, {
      kind: "monitoring-loop-failure",
      title: "title",
      detail: "detail",
      reason: "consecutive-failures",
      detectedAt: new Date("2026-07-18T12:55:00.000Z"),
      recipients: ["ops@example.com", "oncall@example.com", "OPS@example.com"],
    }, {
      now: new Date("2026-07-18T12:55:00.000Z"),
      createId: () => "should-not-insert",
    });
    expect(second).toHaveLength(0);
    expect(inserted).toHaveLength(2);
    expect(normalizeRecipient(" Ops@Example.COM ")).toBe("ops@example.com");
  });

  it("scoped system.alert claim never returns ordinary outbox rows", async () => {
    const store = createMemoryOutbox([
      systemRow({ id: "system-1", nextAttemptAt: hour, createdAt: hour }),
      systemRow({
        id: "incident-1",
        eventType: "incident.opened",
        idempotencyKey: "incident/key",
        payload: {
          type: "incident.opened",
          monitorName: "API",
          incidentId: "inc-1",
          startedAt: "now",
          cause: "timeout",
        },
        recipient: "ops@example.com",
        nextAttemptAt: hour,
        createdAt: hour,
      }),
    ]);

    const claimed = await claimNotifications(store.db, {
      now: hour,
      limit: 50,
      claimToken: "sweep-only",
      eventTypes: ["system.alert"],
    });
    expect(claimed.map((row) => row.id)).toEqual(["system-1"]);
    expect(store.get("incident-1")?.status).toBe("pending");
  });
});
