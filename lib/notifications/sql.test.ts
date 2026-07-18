import { describe, expect, it, vi } from "vitest";
import {
  CLAIM_NOTIFICATIONS_SQL,
  MARK_NOTIFICATION_FAILED_SQL,
  MARK_NOTIFICATION_SENT_SQL,
  RECONCILE_STALE_CLAIMS_SQL,
  claimNotifications,
  markNotificationFailed,
  markNotificationSent,
  reconcileStaleClaims,
  type SqlExecutor,
} from "./sql";

describe("outbox SQL", () => {
  it("claims due rows atomically with locking and a returned token", async () => {
    expect(CLAIM_NOTIFICATIONS_SQL).toMatch(/for update skip locked/i);
    expect(CLAIM_NOTIFICATIONS_SQL).toMatch(/update notification_outbox[\s\S]*returning/i);
    const query = vi.fn(async (text: string, values: readonly unknown[]) => {
      void text;
      void values;
      return [{
        id: "notification-1",
        incident_id: "incident-1",
        monitor_id: "api",
        event_type: "incident.opened",
        recipient: "ops@example.com",
        idempotency_key: "permanent-key",
        payload: { type: "incident.opened", monitorName: "API", incidentId: "incident-1", startedAt: "now", cause: "timeout" },
        attempt_count: 1,
        claim_token: "claim-1",
      }];
    });
    const now = new Date("2026-07-18T00:00:00Z");
    const rows = await claimNotifications({ query } as SqlExecutor, { now, limit: 25, claimToken: "claim-1" });
    expect(query).toHaveBeenCalledWith(CLAIM_NOTIFICATIONS_SQL, [now, 25, "claim-1"]);
    expect(rows[0]).toMatchObject({ id: "notification-1", claimToken: "claim-1", attemptCount: 1 });
  });

  it("recovers only sending claims older than five minutes", async () => {
    expect(RECONCILE_STALE_CLAIMS_SQL).toMatch(/status = 'sending'/i);
    expect(RECONCILE_STALE_CLAIMS_SQL).toMatch(/claim_token = null/i);
    const query = vi.fn(async (text: string, values: readonly unknown[]) => {
      void text;
      void values;
      return [{ id: "stale-1" }];
    });
    const now = new Date("2026-07-18T00:10:00Z");
    await expect(reconcileStaleClaims({ query } as SqlExecutor, now)).resolves.toBe(1);
    expect(query).toHaveBeenCalledWith(RECONCILE_STALE_CLAIMS_SQL, [
      now,
      new Date("2026-07-18T00:05:00Z"),
    ]);
  });

  it("guards success and failure finalization with the claim token", async () => {
    expect(MARK_NOTIFICATION_SENT_SQL).toMatch(/claim_token = \$2/i);
    expect(MARK_NOTIFICATION_FAILED_SQL).toMatch(/claim_token = \$2/i);
    const query = vi.fn(async (text: string, values: readonly unknown[]) => {
      void text;
      void values;
      return [{ id: "notification-1" }];
    });
    const db = { query } as SqlExecutor;
    const now = new Date("2026-07-18T00:00:00Z");
    await expect(markNotificationSent(db, { id: "notification-1", claimToken: "claim-1" }, "email-1", now)).resolves.toBe(true);
    await expect(markNotificationFailed(db, { id: "notification-1", claimToken: "claim-1" }, {
      dead: false,
      nextAttemptAt: new Date("2026-07-18T00:01:00Z"),
      errorCode: "rate_limit_exceeded",
      now,
    })).resolves.toBe(true);
  });
});
