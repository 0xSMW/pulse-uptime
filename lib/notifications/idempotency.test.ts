import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  incidentNotificationKey,
  normalizeRecipient,
  recipientHash,
  testNotificationKey,
} from "./idempotency";

describe("notification idempotency", () => {
  it("normalizes recipients before producing permanent incident keys", () => {
    const expectedHash = createHash("sha256").update("ops@example.com").digest("hex");
    expect(normalizeRecipient(" Ops@Example.COM ")).toBe("ops@example.com");
    expect(recipientHash(" Ops@Example.COM ")).toBe(expectedHash);
    expect(incidentNotificationKey("incident-1", "opened", " Ops@Example.COM "))
      .toBe(`incident/incident-1/opened/${expectedHash}`);
    expect(incidentNotificationKey("incident-1", "resolved", "ops@example.com"))
      .toBe(`incident/incident-1/resolved/${expectedHash}`);
    expect(testNotificationKey("request-1", "ops@example.com"))
      .toBe(`test/request-1/${expectedHash}`);
  });
});
