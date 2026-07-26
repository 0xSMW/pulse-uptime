import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import type { DomainHealthCronResult } from "@/lib/domain-health/runtime"
import {
  processPorkbunWebhookReceipts,
  receivePorkbunWebhookRequest,
} from "./runtime"
import type { ClaimedPorkbunWebhookReceipt } from "./store"

const receivedAt = new Date("2026-07-26T12:00:00.000Z")

function receipt(
  overrides: Partial<ClaimedPorkbunWebhookReceipt> = {}
): ClaimedPorkbunWebhookReceipt {
  return {
    attemptCount: 1,
    domain: "example.com",
    event: "domain.renewed",
    eventCreatedAt: receivedAt.toISOString(),
    eventId: "event-1",
    expireDate: null,
    payloadDigest: "digest",
    processingStartedAt: receivedAt,
    receivedAt,
    ...overrides,
  }
}

function completed(
  porkbunRefreshedApexDomains: string[] = []
): DomainHealthCronResult {
  return {
    certProbes: 0,
    counts: {
      failureCount: 0,
      monitorCount: 0,
      skippedCount: 0,
      successCount: 0,
      unknownCount: 0,
    },
    rdapLookups: 0,
    porkbunRefreshedApexDomains,
    runId: "run-1",
    skippedLookups: 0,
    status: "completed",
  }
}

describe("receivePorkbunWebhookRequest", () => {
  it("records health only after an accepted receiver response", async () => {
    const noteReceived = vi.fn().mockResolvedValue(undefined)
    const receive = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }))

    const response = await receivePorkbunWebhookRequest(
      new Request("https://pulse.test/api/webhooks/porkbun", {
        method: "POST",
      }),
      {
        noteReceived,
        persistence: { record: vi.fn() },
        readSigningSecret: vi.fn().mockResolvedValue("decrypted-secret"),
        receive,
      }
    )

    expect(response.status).toBe(204)
    expect(receive).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ signingSecret: "decrypted-secret" })
    )
    expect(noteReceived).toHaveBeenCalledOnce()
  })

  it("does not record health for rejected requests", async () => {
    const noteReceived = vi.fn()

    const response = await receivePorkbunWebhookRequest(
      new Request("https://pulse.test/api/webhooks/porkbun", {
        method: "POST",
      }),
      {
        noteReceived,
        persistence: { record: vi.fn() },
        readSigningSecret: vi.fn().mockResolvedValue("decrypted-secret"),
        receive: vi.fn().mockResolvedValue(new Response(null, { status: 400 })),
      }
    )

    expect(response.status).toBe(400)
    expect(noteReceived).not.toHaveBeenCalled()
  })

  it("does not disclose a secret loading failure", async () => {
    const response = await receivePorkbunWebhookRequest(
      new Request("https://pulse.test/api/webhooks/porkbun", {
        method: "POST",
      }),
      {
        noteReceived: vi.fn(),
        persistence: { record: vi.fn() },
        readSigningSecret: vi.fn().mockRejectedValue(new Error("secret value")),
        receive: vi.fn(),
      }
    )

    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain("secret value")
  })
})

describe("processPorkbunWebhookReceipts", () => {
  it("processes test receipts and forces unique domain apexes after a completed cron", async () => {
    const testReceipt = receipt({
      domain: null,
      event: "webhook.test",
      eventId: "test",
    })
    const first = receipt({ eventId: "renewed" })
    const second = receipt({
      domain: "other.example",
      event: "domain.expiring",
      eventId: "expiring",
    })
    const markProcessed = vi.fn().mockResolvedValue(true)
    const runDomainHealthCron = vi
      .fn()
      .mockResolvedValue(completed(["example.com", "other.example"]))

    const result = await processPorkbunWebhookReceipts({
      claim: vi.fn().mockResolvedValue([testReceipt, first, second]),
      markFailed: vi.fn().mockResolvedValue(true),
      markProcessed,
      now: () => receivedAt,
      runDomainHealthCron,
    })

    expect(runDomainHealthCron).toHaveBeenCalledWith(
      new Set(["example.com", "other.example"])
    )
    expect(markProcessed).toHaveBeenCalledWith(testReceipt)
    expect(markProcessed).toHaveBeenCalledWith(first)
    expect(markProcessed).toHaveBeenCalledWith(second)
    expect(result.forcedApexDomains).toEqual(["example.com", "other.example"])
  })

  it("releases domain receipts when the domain cron lease is held", async () => {
    const pending = receipt()
    const markFailed = vi.fn().mockResolvedValue(true)

    const result = await processPorkbunWebhookReceipts({
      claim: vi.fn().mockResolvedValue([pending]),
      markFailed,
      markProcessed: vi.fn(),
      now: () => receivedAt,
      runDomainHealthCron: vi.fn().mockResolvedValue({ status: "lease-held" }),
    })

    expect(result.cron.status).toBe("lease-held")
    expect(markFailed).toHaveBeenCalledWith(pending, "domain_cron_lease_held")
  })

  it("keeps a receipt retryable when a provider outage prevents Porkbun refresh", async () => {
    const pending = receipt()
    const markFailed = vi.fn().mockResolvedValue(true)

    await processPorkbunWebhookReceipts({
      claim: vi.fn().mockResolvedValue([pending]),
      markFailed,
      markProcessed: vi.fn(),
      now: () => receivedAt,
      // A completed coordinator can still contain an RDAP fallback after the
      // portfolio failed to confirm this domain.
      runDomainHealthCron: vi.fn().mockResolvedValue(completed()),
    })

    expect(markFailed).toHaveBeenCalledWith(
      pending,
      "porkbun_refresh_not_confirmed"
    )
  })

  it("keeps a receipt retryable when the forced apex misses the work budget", async () => {
    const pending = receipt()
    const markFailed = vi.fn().mockResolvedValue(true)

    await processPorkbunWebhookReceipts({
      claim: vi.fn().mockResolvedValue([pending]),
      markFailed,
      markProcessed: vi.fn(),
      now: () => receivedAt,
      // The coordinator remains completed when another task consumes the
      // admission budget, but supplies no persisted Porkbun evidence.
      runDomainHealthCron: vi.fn().mockResolvedValue(completed()),
    })

    expect(markFailed).toHaveBeenCalledWith(
      pending,
      "porkbun_refresh_not_confirmed"
    )
  })

  it("releases domain receipts when the cron throws", async () => {
    const pending = receipt()
    const markFailed = vi.fn().mockResolvedValue(true)

    await expect(
      processPorkbunWebhookReceipts({
        claim: vi.fn().mockResolvedValue([pending]),
        markFailed,
        markProcessed: vi.fn(),
        now: () => receivedAt,
        runDomainHealthCron: vi.fn().mockRejectedValue(new Error("down")),
      })
    ).rejects.toThrow("Domain health cron failed")

    expect(markFailed).toHaveBeenCalledWith(pending, "domain_cron_exception")
  })
})
