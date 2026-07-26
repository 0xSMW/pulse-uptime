import { describe, expect, it, vi } from "vitest"
import type { DomainExpiryOutboxRow } from "@/lib/domain-health/alerts"
import {
  createDomainExpiryOutboxEnqueuer,
  enqueueDomainExpiryOutboxRows,
} from "./domain-expiry"
import { ORDINARY_NOTIFICATION_EVENT_TYPES } from "./types"

const now = new Date("2026-07-26T12:00:00.000Z")

function row(): DomainExpiryOutboxRow {
  return {
    id: "domain-alert-1",
    eventType: "domain.expiry",
    recipient: "ops@example.com",
    idempotencyKey: "domain-expiry/example.com/expiry/14/recipient",
    payload: {
      type: "domain.expiry",
      apexDomain: "example.com",
      expiresAt: "2026-08-09T12:00:00.000Z",
      thresholdDays: 14,
      autoRenew: null,
    },
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  }
}

function fakeDatabase(insertedRows: DomainExpiryOutboxRow[] = []) {
  const returning = vi.fn().mockResolvedValue(insertedRows)
  const onConflictDoNothing = vi.fn(() => ({ returning }))
  const values = vi.fn(() => ({ onConflictDoNothing }))
  const insert = vi.fn(() => ({ values }))
  return { db: { insert }, insert, values, onConflictDoNothing, returning }
}

describe("domain expiry outbox adapter", () => {
  it("is eligible for ordinary outbox delivery", () => {
    expect(ORDINARY_NOTIFICATION_EVENT_TYPES).toContain("domain.expiry")
  })

  it("writes domain-only rows and ignores idempotency conflicts", async () => {
    const fake = fakeDatabase([row()])
    const result = await enqueueDomainExpiryOutboxRows(fake.db as never, [
      row(),
    ])

    expect(result).toBe(1)
    expect(fake.values).toHaveBeenCalledWith([row()])
    expect(fake.onConflictDoNothing).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.anything() })
    )
  })

  it("does not open a database chain for no rows", async () => {
    const fake = fakeDatabase()
    await expect(
      enqueueDomainExpiryOutboxRows(fake.db as never, [])
    ).resolves.toBe(0)
    expect(fake.insert).not.toHaveBeenCalled()
  })

  it("binds the database as the pure policy enqueuer", async () => {
    const fake = fakeDatabase([row()])
    const enqueue = createDomainExpiryOutboxEnqueuer(fake.db as never)

    await expect(enqueue([row()])).resolves.toBe(1)
    expect(fake.values).toHaveBeenCalledWith([row()])
  })
})
