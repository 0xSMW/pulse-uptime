import { describe, expect, it, vi } from "vitest";
import { ENQUEUE_NOTIFICATION_SQL, enqueueIncidentNotifications } from "./enqueue";
import type { SqlExecutor } from "./sql";

describe("incident notification enqueue", () => {
  it("deduplicates normalized recipients and relies on the permanent key constraint", async () => {
    expect(ENQUEUE_NOTIFICATION_SQL).toMatch(/on conflict \(idempotency_key\) do nothing/i);
    const query = vi.fn(async (text: string, values: readonly unknown[]) => {
      void text;
      void values;
      return [{ id: "inserted" }];
    });
    const inserted = await enqueueIncidentNotifications({ query } as SqlExecutor, {
      event: "opened",
      incidentId: "incident-1",
      monitorId: "api",
      monitorName: "Public API",
      recipients: ["Ops@example.com", " ops@EXAMPLE.com "],
      startedAt: "now",
      cause: "timeout",
    }, {
      now: new Date("2026-07-18T00:00:00Z"),
      createId: () => "notification-1",
    });
    expect(inserted).toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
    const values = query.mock.calls[0]?.[1];
    expect(values?.[4]).toBe("ops@example.com");
    expect(values?.[5]).toMatch(/^incident\/incident-1\/opened\/[a-f0-9]{64}$/);
    expect(values?.[6]).toMatchObject({ type: "incident.opened", incidentId: "incident-1" });
  });
});
