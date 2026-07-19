import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  dependencyNotificationKey,
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

  it("builds dependency keys from source, provider incident id, preset, event, and recipient", () => {
    const expectedHash = createHash("sha256").update("ops@example.com").digest("hex");
    expect(dependencyNotificationKey("vercel", "inc-123", "vercel_runtime", "incident", "ops@example.com"))
      .toBe(`dependency/vercel/inc-123/vercel_runtime/incident/${expectedHash}`);
    expect(dependencyNotificationKey("vercel", "inc-123", "vercel_runtime", "recovery", " Ops@Example.COM "))
      .toBe(`dependency/vercel/inc-123/vercel_runtime/recovery/${expectedHash}`);
  });

  it("gives distinct dependency keys for distinct presets sharing the same source and incident", () => {
    const a = dependencyNotificationKey("vercel", "inc-123", "vercel_runtime", "incident", "ops@example.com");
    const b = dependencyNotificationKey("vercel", "inc-123", "vercel_deployments", "incident", "ops@example.com");
    expect(a).not.toBe(b);
  });
});
