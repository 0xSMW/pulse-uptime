import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  dependencyNotificationKey,
  incidentNotificationKey,
  normalizeRecipient,
  recipientHash,
  testNotificationKey,
} from "./idempotency"

describe("notification idempotency", () => {
  it("normalizes recipients before producing permanent incident keys", () => {
    const expectedHash = createHash("sha256")
      .update("ops@example.com")
      .digest("hex")
    expect(normalizeRecipient(" Ops@Example.COM ")).toBe("ops@example.com")
    expect(recipientHash(" Ops@Example.COM ")).toBe(expectedHash)
    expect(
      incidentNotificationKey("incident-1", "opened", " Ops@Example.COM ")
    ).toBe(`incident/incident-1/opened/${expectedHash}`)
    expect(
      incidentNotificationKey("incident-1", "resolved", "ops@example.com")
    ).toBe(`incident/incident-1/resolved/${expectedHash}`)
    expect(testNotificationKey("request-1", "ops@example.com")).toBe(
      `test/request-1/${expectedHash}`
    )
  })

  it("builds dependency keys from source, provider incident id, catalog id, scope, event, and recipient", () => {
    const expectedHash = createHash("sha256")
      .update("ops@example.com")
      .digest("hex")
    expect(
      dependencyNotificationKey(
        "vercel",
        "inc-123",
        "vercel_runtime",
        null,
        "incident",
        "ops@example.com"
      )
    ).toBe(`dependency/vercel/inc-123/vercel_runtime//incident/${expectedHash}`)
    expect(
      dependencyNotificationKey(
        "vercel",
        "inc-123",
        "vercel_runtime",
        null,
        "recovery",
        " Ops@Example.COM "
      )
    ).toBe(`dependency/vercel/inc-123/vercel_runtime//recovery/${expectedHash}`)
  })

  it("gives distinct dependency keys for distinct presets sharing the same source and incident", () => {
    const a = dependencyNotificationKey(
      "vercel",
      "inc-123",
      "vercel_runtime",
      null,
      "incident",
      "ops@example.com"
    )
    const b = dependencyNotificationKey(
      "vercel",
      "inc-123",
      "vercel_deployments",
      null,
      "incident",
      "ops@example.com"
    )
    expect(a).not.toBe(b)
  })

  it("gives distinct dependency keys for two scoped installs of the same preset (FIX C)", () => {
    const usEast = dependencyNotificationKey(
      "neon",
      "inc-123",
      "neon_database",
      "us-east-1",
      "incident",
      "ops@example.com"
    )
    const euWest = dependencyNotificationKey(
      "neon",
      "inc-123",
      "neon_database",
      "eu-west-2",
      "incident",
      "ops@example.com"
    )
    expect(usEast).not.toBe(euWest)
    expect(usEast).toContain("/us-east-1/")
    expect(euWest).toContain("/eu-west-2/")
  })

  it("normalizes a null scopeId to an empty path segment", () => {
    const key = dependencyNotificationKey(
      "vercel",
      "inc-123",
      "vercel_runtime",
      null,
      "incident",
      "ops@example.com"
    )
    expect(key).toMatch(
      /^dependency\/vercel\/inc-123\/vercel_runtime\/\/incident\/[a-f0-9]{64}$/
    )
  })

  it("leaves the key unchanged when occurrence is omitted", () => {
    const withoutOccurrence = dependencyNotificationKey(
      "vercel",
      "inc-123",
      "vercel_runtime",
      null,
      "incident",
      "ops@example.com"
    )
    const explicitUndefined = dependencyNotificationKey(
      "vercel",
      "inc-123",
      "vercel_runtime",
      null,
      "incident",
      "ops@example.com",
      undefined
    )
    expect(withoutOccurrence).toBe(explicitUndefined)
    expect(withoutOccurrence).not.toContain("undefined")
  })

  it("appends occurrence as a trailing key component, distinct from the occurrence-less key", () => {
    const expectedHash = createHash("sha256")
      .update("ops@example.com")
      .digest("hex")
    const withOccurrence = dependencyNotificationKey(
      "vercel",
      "inc-123",
      "vercel_runtime",
      null,
      "recovery",
      "ops@example.com",
      "1737300000000"
    )
    expect(withOccurrence).toBe(
      `dependency/vercel/inc-123/vercel_runtime//recovery/${expectedHash}/1737300000000`
    )

    const withoutOccurrence = dependencyNotificationKey(
      "vercel",
      "inc-123",
      "vercel_runtime",
      null,
      "recovery",
      "ops@example.com"
    )
    expect(withOccurrence).not.toBe(withoutOccurrence)
  })

  it("gives distinct keys for two occurrences of the same source, incident id, preset, scope, event, and recipient", () => {
    const first = dependencyNotificationKey(
      "vercel",
      "inc-123",
      "vercel_runtime",
      null,
      "recovery",
      "ops@example.com",
      "1737300000000"
    )
    const second = dependencyNotificationKey(
      "vercel",
      "inc-123",
      "vercel_runtime",
      null,
      "recovery",
      "ops@example.com",
      "1737400000000"
    )
    expect(first).not.toBe(second)
  })
})
