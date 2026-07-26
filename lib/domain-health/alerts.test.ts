import { describe, expect, it, vi } from "vitest"

import {
  buildDomainExpiryAlertRows,
  domainExpiryAlertKey,
  enqueueDomainExpiryAlerts,
} from "./alerts"

const now = new Date("2026-07-26T12:00:00.000Z")

function inDays(days: number): Date {
  return new Date(now.getTime() + days * 86_400_000)
}

describe("domain expiry alerts", () => {
  it("is disabled by default and does not call the injected writer", async () => {
    const enqueue = vi.fn<() => Promise<number>>()
    const result = await enqueueDomainExpiryAlerts(
      {
        registrations: [
          { apexDomain: "example.com", expiresAt: inDays(14), autoRenew: null },
        ],
        defaultRecipients: ["ops@example.com"],
        now,
        createId: () => "row-1",
      },
      enqueue
    )

    expect(result).toBe(0)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it("enqueues only the 14-day alert for each default recipient when first seen below 14 days", () => {
    let sequence = 0
    const rows = buildDomainExpiryAlertRows({
      settings: { enabled: true },
      registrations: [
        {
          apexDomain: " Example.COM ",
          expiresAt: inDays(12),
          autoRenew: true,
        },
      ],
      defaultRecipients: [
        " Ops@Example.COM ",
        "oncall@example.com",
        "ops@example.com",
      ],
      now,
      createId: () => {
        sequence += 1
        return `row-${sequence}`
      },
    })

    expect(rows).toHaveLength(2)
    expect(
      rows.map((row) => row.recipient).sort((a, b) => a.localeCompare(b))
    ).toEqual(["oncall@example.com", "ops@example.com"])
    expect(
      rows.map((row) => row.payload.thresholdDays).sort((a, b) => a - b)
    ).toEqual([14, 14])
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "domain.expiry",
          status: "pending",
          attemptCount: 0,
          nextAttemptAt: now,
          payload: {
            type: "domain.expiry",
            apexDomain: "example.com",
            expiresAt: inDays(12).toISOString(),
            thresholdDays: 14,
            autoRenew: true,
          },
        }),
      ])
    )
  })

  it("does not emit either threshold before the 30-day window", () => {
    const rows = buildDomainExpiryAlertRows({
      settings: { enabled: true },
      registrations: [
        { apexDomain: "example.com", expiresAt: inDays(31), autoRenew: false },
      ],
      defaultRecipients: ["ops@example.com"],
      now,
      createId: () => "row-1",
    })

    expect(rows).toEqual([])
  })

  it("selects the 30-day alert before the 14-day threshold is reached", () => {
    const rows = buildDomainExpiryAlertRows({
      settings: { enabled: true },
      registrations: [
        { apexDomain: "example.com", expiresAt: inDays(20), autoRenew: null },
      ],
      defaultRecipients: ["ops@example.com"],
      now,
      createId: () => "row-1",
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload.thresholdDays).toBe(30)
  })

  it("uses apex, expiry instant, threshold, and recipient in the idempotency key", () => {
    const expiresAt = inDays(14)
    const initial = domainExpiryAlertKey(
      "Example.com",
      expiresAt,
      14,
      "Ops@example.com"
    )

    expect(
      domainExpiryAlertKey("example.com", expiresAt, 14, "ops@example.com")
    ).toBe(initial)
    expect(
      domainExpiryAlertKey("example.net", expiresAt, 14, "ops@example.com")
    ).not.toBe(initial)
    expect(
      domainExpiryAlertKey("example.com", inDays(15), 14, "ops@example.com")
    ).not.toBe(initial)
    expect(
      domainExpiryAlertKey("example.com", expiresAt, 30, "ops@example.com")
    ).not.toBe(initial)
    expect(
      domainExpiryAlertKey("example.com", expiresAt, 14, "other@example.com")
    ).not.toBe(initial)
  })

  it("preserves auto-renew as context and never uses it to suppress an alert", () => {
    const rows = buildDomainExpiryAlertRows({
      settings: { enabled: true },
      registrations: [
        { apexDomain: "example.com", expiresAt: inDays(30), autoRenew: true },
      ],
      defaultRecipients: ["ops@example.com"],
      now,
      createId: () => "row-1",
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toMatchObject({
      thresholdDays: 30,
      autoRenew: true,
    })
  })
})
