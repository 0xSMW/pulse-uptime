import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NotificationProviderError, type NotificationSender } from "./provider";
import { deliverPendingNotifications, retryAt } from "./delivery";
import { incidentUrl, createNotificationMessage } from "./message";
import type { SqlExecutor } from "./sql";
import type { ClaimedNotification, DeliveryLogEntry } from "./types";

function claimed(overrides: Partial<ClaimedNotification> = {}): ClaimedNotification {
  return {
    id: "notification-1",
    incidentId: "incident-1",
    monitorId: "api",
    dependencyId: null,
    eventType: "incident.opened",
    recipient: "ops@example.com",
    idempotencyKey: "incident/incident-1/opened/hash",
    payload: {
      type: "incident.opened",
      monitorName: "Public API",
      incidentId: "incident-1",
      startedAt: "Jul 18 at 07:00 UTC",
      cause: "Connection timed out",
    },
    attemptCount: 1,
    claimToken: "claim-1",
    ...overrides,
  };
}

function dbReturning(rows: ClaimedNotification[], finalize = true): SqlExecutor {
  return {
    async query<T>(text: string): Promise<readonly T[]> {
      if (text.includes("with due as")) {
        return rows.map((row) => ({
          id: row.id,
          incident_id: row.incidentId,
          monitor_id: row.monitorId,
          event_type: row.eventType,
          recipient: row.recipient,
          idempotency_key: row.idempotencyKey,
          payload: row.payload,
          attempt_count: row.attemptCount,
          claim_token: row.claimToken,
        })) as T[];
      }
      return (finalize ? [{ id: "updated" }] : []) as T[];
    },
  };
}

describe("notification messages", () => {
  it("links outage email to the canonical incident route", () => {
    expect(incidentUrl("https://pulse.example.com/base?old=1", "incident/1"))
      .toBe("https://pulse.example.com/incidents/incident%2F1");
    const message = createNotificationMessage(claimed(), "https://pulse.example.com");
    const html = renderToStaticMarkup(message.react);
    expect(message.subject).toBe("Public API is down");
    expect(html).toContain("https://pulse.example.com/incidents/incident-1");
    expect(html).toContain("Connection timed out");
  });

  it("builds concise recovery and test messages", () => {
    const recovery = createNotificationMessage(claimed({
      eventType: "incident.resolved",
      payload: {
        type: "incident.resolved",
        monitorName: "Public API",
        incidentId: "incident-1",
        recoveredAt: "Jul 18 at 07:08 UTC",
        duration: "8 minutes",
      },
    }), "https://pulse.example.com");
    expect(recovery.subject).toBe("Public API recovered");
    expect(renderToStaticMarkup(recovery.react)).toContain("8 minutes");

    const test = createNotificationMessage(claimed({
      eventType: "notification.test",
      incidentId: null,
      payload: { type: "notification.test", installationName: "Production" },
    }), "https://pulse.example.com");
    expect(test.subject).toBe("Pulse notification test");
    expect(renderToStaticMarkup(test.react)).toContain("Production can deliver");
  });

  it("renders a dependency incident notification with neutral provider-reported wording", () => {
    const message = createNotificationMessage(claimed({
      eventType: "dependency.incident",
      incidentId: null,
      monitorId: null,
      dependencyId: "dep-1",
      payload: {
        type: "dependency.incident",
        dependencyName: "Vercel Runtime",
        provider: "Vercel",
        incidentTitle: "Elevated function errors",
        state: "OUTAGE",
        canonicalUrl: "https://www.vercel-status.com/incidents/inc-1",
        providerTimestamp: "Jul 19 at 12:00 UTC",
      },
    }), "https://pulse.example.com");
    expect(message.subject).toBe("Vercel Runtime: provider reported incident");
    const html = renderToStaticMarkup(message.react);
    expect(html).toContain("Vercel reports Elevated function errors");
    expect(html).toContain("https://www.vercel-status.com/incidents/inc-1");
    expect(html).toContain("not an independent Pulse check");
  });

  it("renders a dependency recovery notification", () => {
    const message = createNotificationMessage(claimed({
      eventType: "dependency.recovery",
      incidentId: null,
      monitorId: null,
      dependencyId: "dep-1",
      payload: {
        type: "dependency.recovery",
        dependencyName: "Vercel Runtime",
        provider: "Vercel",
        incidentTitle: "Elevated function errors",
        state: "OPERATIONAL",
        canonicalUrl: null,
        providerTimestamp: "Jul 19 at 12:30 UTC",
      },
    }), "https://pulse.example.com");
    expect(message.subject).toBe("Vercel Runtime: provider incident resolved");
    expect(renderToStaticMarkup(message.react)).toContain("Elevated function errors resolved");
  });

  it("rejects a payload whose type does not match its event", () => {
    expect(() => createNotificationMessage(claimed({
      eventType: "dependency.incident",
      incidentId: null,
      payload: {
        type: "dependency.recovery",
        dependencyName: "Vercel Runtime",
        provider: "Vercel",
        incidentTitle: "x",
        state: "OPERATIONAL",
        canonicalUrl: null,
        providerTimestamp: "now",
      },
    }), "https://pulse.example.com")).toThrow(/does not match/);
  });
});

describe("outbox delivery", () => {
  const now = new Date("2026-07-18T00:00:00Z");

  it("passes the permanent key to the sender and records a safe sent event", async () => {
    const send = vi.fn(async () => ({ providerMessageId: "email-1" }));
    const logs: DeliveryLogEntry[] = [];
    const result = await deliverPendingNotifications({
      db: dbReturning([claimed()]),
      sender: { send },
      appUrl: "https://pulse.example.com",
      now: () => now,
      createClaimToken: () => "claim-1",
      log: (entry) => logs.push(entry),
    });
    expect(result).toEqual({ claimed: 1, sent: 1, failed: 0, dead: 0, lostClaims: 0 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "ops@example.com" }), "incident/incident-1/opened/hash");
    expect(logs).toEqual([expect.objectContaining({ event: "notification.sent", notificationId: "notification-1" })]);
    expect(JSON.stringify(logs)).not.toContain("ops@example.com");
  });

  it("retries transient failures with backoff and never logs provider messages", async () => {
    const logs: DeliveryLogEntry[] = [];
    const sender: NotificationSender = {
      async send() {
        throw new NotificationProviderError("rate_limit_exceeded", true);
      },
    };
    const result = await deliverPendingNotifications({
      db: dbReturning([claimed()]), sender, appUrl: "https://pulse.example.com",
      now: () => now, log: (entry) => logs.push(entry),
    });
    expect(result.failed).toBe(1);
    expect(result.dead).toBe(0);
    expect(logs[0]).toMatchObject({ errorCode: "rate_limit_exceeded" });
    expect(retryAt(now, 1)).toEqual(new Date("2026-07-18T00:01:00Z"));
    expect(retryAt(now, 4)).toEqual(new Date("2026-07-18T02:00:00Z"));
  });

  it("marks permanent errors and exhausted retries dead", async () => {
    const permanent: NotificationSender = {
      async send() { throw new NotificationProviderError("invalid_from_address", false); },
    };
    const exhausted: NotificationSender = {
      async send() { throw new NotificationProviderError("internal_server_error", true); },
    };
    const permanentResult = await deliverPendingNotifications({
      db: dbReturning([claimed()]), sender: permanent, appUrl: "https://pulse.example.com", now: () => now,
    });
    const exhaustedResult = await deliverPendingNotifications({
      db: dbReturning([claimed({ attemptCount: 5 })]), sender: exhausted,
      appUrl: "https://pulse.example.com", now: () => now,
    });
    expect(permanentResult.dead).toBe(1);
    expect(exhaustedResult.dead).toBe(1);
  });

  it("caps concurrency and reports token-guarded updates that lose their claim", async () => {
    let active = 0;
    let peak = 0;
    const sender: NotificationSender = {
      async send() {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return { providerMessageId: "email" };
      },
    };
    const rows = Array.from({ length: 8 }, (_, index) => claimed({ id: `n-${index}` }));
    const result = await deliverPendingNotifications({
      db: dbReturning(rows, false), sender, appUrl: "https://pulse.example.com", now: () => now,
    }, { concurrency: 3 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(result.lostClaims).toBe(8);
    expect(result.sent).toBe(0);
  });
});
