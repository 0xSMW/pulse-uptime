import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import type { DomainHealthCronResult } from "@/lib/domain-health/runtime"
import { receivePorkbunWebhook } from "./receiver"
import {
  createPorkbunWebhookSourceAdmission,
  PORKBUN_WEBHOOK_INGRESS_LIMIT,
  PORKBUN_WEBHOOK_RECEIPT_MAX_ATTEMPTS,
  processPorkbunWebhookReceipts,
  receivePorkbunWebhookRequest,
} from "./runtime"
import {
  type ClaimedPorkbunWebhookReceipt,
  encryptPorkbunWebhookSecret,
  readPorkbunWebhookSigningSecret,
} from "./store"

const receivedAt = new Date("2026-07-26T12:00:00.000Z")
const ingressTimestamp = String(Math.floor(receivedAt.getTime() / 1000))

function admittedRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://pulse.test/api/webhooks/porkbun", {
    headers: {
      "x-porkbun-event": "webhook.test",
      "x-porkbun-signature": `sha256=${"a".repeat(64)}`,
      "x-porkbun-webhook-id": "event-1",
      "x-porkbun-webhook-timestamp": ingressTimestamp,
      ...headers,
    },
    method: "POST",
  })
}

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

    const response = await receivePorkbunWebhookRequest(admittedRequest(), {
      noteReceived,
      persistence: { record: vi.fn() },
      readSigningSecret: vi.fn().mockResolvedValue("decrypted-secret"),
      receive,
      now: () => receivedAt,
    })

    expect(response.status).toBe(204)
    expect(receive).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ signingSecret: "decrypted-secret" })
    )
    expect(noteReceived).toHaveBeenCalledOnce()
  })

  it("does not record health for rejected requests", async () => {
    const noteReceived = vi.fn()

    const response = await receivePorkbunWebhookRequest(admittedRequest(), {
      noteReceived,
      persistence: { record: vi.fn() },
      readSigningSecret: vi.fn().mockResolvedValue("decrypted-secret"),
      receive: vi.fn().mockResolvedValue(new Response(null, { status: 400 })),
      now: () => receivedAt,
    })

    expect(response.status).toBe(400)
    expect(noteReceived).not.toHaveBeenCalled()
  })

  it("does not disclose a secret loading failure", async () => {
    const response = await receivePorkbunWebhookRequest(admittedRequest(), {
      noteReceived: vi.fn(),
      persistence: { record: vi.fn() },
      readSigningSecret: vi.fn().mockRejectedValue(new Error("secret value")),
      receive: vi.fn(),
      now: () => receivedAt,
    })

    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain("secret value")
  })

  it.each([
    ["missing headers", new Request("https://pulse.test/api/webhooks/porkbun")],
    [
      "malformed timestamp",
      admittedRequest({ "x-porkbun-webhook-timestamp": "tomorrow" }),
    ],
    [
      "oversized declared body",
      admittedRequest({ "content-length": String(64 * 1024 + 1) }),
    ],
  ])("rejects %s before reading the signing secret", async (_name, request) => {
    const readSigningSecret = vi.fn()

    const response = await receivePorkbunWebhookRequest(request, {
      noteReceived: vi.fn(),
      persistence: { record: vi.fn() },
      readSigningSecret,
      receive: vi.fn(),
      now: () => receivedAt,
    })

    expect([400, 413]).toContain(response.status)
    expect(readSigningSecret).not.toHaveBeenCalled()
  })

  it("reads durable secret state for each admitted signature", async () => {
    const key = "runtime-test-key-with-at-least-32-characters"
    vi.stubEnv("API_TOKEN_HASH_KEY", key)
    const encrypted = encryptPorkbunWebhookSecret("decrypted-secret", key)
    const limit = vi.fn().mockResolvedValue([{ encrypted }])
    const select = vi.fn(() => ({
      from: () => ({ where: () => ({ limit }) }),
    }))
    const handle = { select } as never
    const dependencies = {
      noteReceived: vi.fn(),
      persistence: { record: vi.fn() },
      readSigningSecret: () => readPorkbunWebhookSigningSecret(handle),
      receive: receivePorkbunWebhook,
      now: () => receivedAt,
    }

    const first = await receivePorkbunWebhookRequest(
      admittedRequest(),
      dependencies
    )
    const second = await receivePorkbunWebhookRequest(
      admittedRequest(),
      dependencies
    )

    expect(first.status).toBe(400)
    expect(second.status).toBe(400)
    expect(select).toHaveBeenCalledTimes(2)
  })

  it("throttles a trusted source before reading the signing secret", async () => {
    const readSigningSecret = vi.fn()
    const response = await receivePorkbunWebhookRequest(
      admittedRequest({ "x-real-ip": "203.0.113.7" }),
      {
        admitSource: () => ({ allowed: false, retryAfterSeconds: 17 }),
        noteReceived: vi.fn(),
        persistence: { record: vi.fn() },
        readSigningSecret,
        receive: vi.fn(),
        now: () => receivedAt,
      }
    )

    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("17")
    expect(await response.json()).toEqual({
      error: "Too many webhook requests",
    })
    expect(readSigningSecret).not.toHaveBeenCalled()
  })

  it("bounds only platform-authenticated source addresses", () => {
    const admitSource = createPorkbunWebhookSourceAdmission()
    const trusted = admittedRequest({ "x-real-ip": "203.0.113.7" })
    for (
      let request = 0;
      request < PORKBUN_WEBHOOK_INGRESS_LIMIT;
      request += 1
    ) {
      expect(admitSource(trusted, receivedAt.getTime()).allowed).toBe(true)
    }
    expect(admitSource(trusted, receivedAt.getTime()).allowed).toBe(false)

    const forwardedOnly = admittedRequest({
      "x-forwarded-for": "203.0.113.7",
    })
    for (
      let request = 0;
      request <= PORKBUN_WEBHOOK_INGRESS_LIMIT;
      request += 1
    ) {
      expect(admitSource(forwardedOnly, receivedAt.getTime()).allowed).toBe(
        true
      )
    }
  })
})

describe("processPorkbunWebhookReceipts", () => {
  it("keeps the empty-queue cron path free of an extra config read", async () => {
    const readMonitoredApexDomains = vi.fn()
    const runDomainHealthCron = vi.fn().mockResolvedValue(completed())

    const result = await processPorkbunWebhookReceipts({
      claim: vi.fn().mockResolvedValue([]),
      defer: vi.fn(),
      markDeadLettered: vi.fn(),
      markFailed: vi.fn(),
      markIgnored: vi.fn(),
      markProcessed: vi.fn(),
      now: () => receivedAt,
      readMonitoredApexDomains,
      runDomainHealthCron,
    })

    expect(readMonitoredApexDomains).not.toHaveBeenCalled()
    expect(runDomainHealthCron).toHaveBeenCalledWith(new Set())
    expect(result.claimedCount).toBe(0)
  })

  it("dead-letters claimed receipts when monitor config stays unavailable", async () => {
    const pending = receipt({
      attemptCount: PORKBUN_WEBHOOK_RECEIPT_MAX_ATTEMPTS,
    })
    const testReceipt = receipt({
      attemptCount: PORKBUN_WEBHOOK_RECEIPT_MAX_ATTEMPTS,
      domain: null,
      event: "webhook.test",
      eventId: "test",
    })
    const markDeadLettered = vi.fn().mockResolvedValue(true)
    const markFailed = vi.fn()

    await expect(
      processPorkbunWebhookReceipts({
        claim: vi.fn().mockResolvedValue([pending, testReceipt]),
        defer: vi.fn(),
        markDeadLettered,
        markFailed,
        markIgnored: vi.fn(),
        markProcessed: vi.fn(),
        now: () => receivedAt,
        readMonitoredApexDomains: vi
          .fn()
          .mockRejectedValue(new Error("invalid accepted config")),
        runDomainHealthCron: vi.fn(),
      })
    ).rejects.toThrow(
      "Monitor configuration failed while processing Porkbun receipts"
    )

    expect(markDeadLettered).toHaveBeenCalledTimes(2)
    expect(markDeadLettered).toHaveBeenCalledWith(
      pending,
      "monitored_domain_config_unavailable"
    )
    expect(markDeadLettered).toHaveBeenCalledWith(
      testReceipt,
      "monitored_domain_config_unavailable"
    )
    expect(markFailed).not.toHaveBeenCalled()
  })

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
      defer: vi.fn(),
      markDeadLettered: vi.fn().mockResolvedValue(true),
      markFailed: vi.fn().mockResolvedValue(true),
      markIgnored: vi.fn().mockResolvedValue(true),
      markProcessed,
      now: () => receivedAt,
      readMonitoredApexDomains: vi
        .fn()
        .mockResolvedValue(new Set(["example.com", "other.example"])),
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
    const defer = vi.fn().mockResolvedValue(true)
    const markFailed = vi.fn().mockResolvedValue(true)

    const result = await processPorkbunWebhookReceipts({
      claim: vi.fn().mockResolvedValue([pending]),
      defer,
      markDeadLettered: vi.fn().mockResolvedValue(true),
      markFailed,
      markIgnored: vi.fn().mockResolvedValue(true),
      markProcessed: vi.fn(),
      now: () => receivedAt,
      readMonitoredApexDomains: vi
        .fn()
        .mockResolvedValue(new Set(["example.com"])),
      runDomainHealthCron: vi.fn().mockResolvedValue({ status: "lease-held" }),
    })

    expect(result.cron.status).toBe("lease-held")
    expect(defer).toHaveBeenCalledWith(pending, "domain_cron_lease_held")
    expect(markFailed).not.toHaveBeenCalled()
  })

  it("keeps repeated lease and duplicate contention attempt-neutral", async () => {
    const pending = receipt({ attemptCount: 5 })
    for (const status of ["lease-held", "duplicate"] as const) {
      const defer = vi.fn().mockResolvedValue(true)
      const markDeadLettered = vi.fn()
      const result = await processPorkbunWebhookReceipts({
        claim: vi.fn().mockResolvedValue([pending]),
        defer,
        markDeadLettered,
        markFailed: vi.fn(),
        markIgnored: vi.fn(),
        markProcessed: vi.fn(),
        now: () => receivedAt,
        readMonitoredApexDomains: vi
          .fn()
          .mockResolvedValue(new Set(["example.com"])),
        runDomainHealthCron: vi
          .fn()
          .mockResolvedValue(
            status === "duplicate" ? { status, runId: "other-run" } : { status }
          ),
      })

      expect(result.cron.status).toBe(status)
      expect(defer).toHaveBeenCalledWith(
        pending,
        status === "duplicate"
          ? "domain_cron_duplicate"
          : "domain_cron_lease_held"
      )
      expect(markDeadLettered).not.toHaveBeenCalled()
    }
  })

  it("keeps a receipt retryable when a provider outage prevents Porkbun refresh", async () => {
    const pending = receipt()
    const markFailed = vi.fn().mockResolvedValue(true)

    await processPorkbunWebhookReceipts({
      claim: vi.fn().mockResolvedValue([pending]),
      defer: vi.fn(),
      markDeadLettered: vi.fn().mockResolvedValue(true),
      markFailed,
      markIgnored: vi.fn().mockResolvedValue(true),
      markProcessed: vi.fn(),
      now: () => receivedAt,
      readMonitoredApexDomains: vi
        .fn()
        .mockResolvedValue(new Set(["example.com"])),
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
      defer: vi.fn(),
      markDeadLettered: vi.fn().mockResolvedValue(true),
      markFailed,
      markIgnored: vi.fn().mockResolvedValue(true),
      markProcessed: vi.fn(),
      now: () => receivedAt,
      readMonitoredApexDomains: vi
        .fn()
        .mockResolvedValue(new Set(["example.com"])),
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
        defer: vi.fn(),
        markDeadLettered: vi.fn().mockResolvedValue(true),
        markFailed,
        markIgnored: vi.fn().mockResolvedValue(true),
        markProcessed: vi.fn(),
        now: () => receivedAt,
        readMonitoredApexDomains: vi
          .fn()
          .mockResolvedValue(new Set(["example.com"])),
        runDomainHealthCron: vi.fn().mockRejectedValue(new Error("down")),
      })
    ).rejects.toThrow("Domain health cron failed")

    expect(markFailed).toHaveBeenCalledWith(pending, "domain_cron_exception")
  })

  it("terminally ignores signed events for unmonitored domains", async () => {
    const ignored = receipt({ domain: "unmonitored.example" })
    const relevant = receipt({ eventId: "relevant" })
    const markIgnored = vi.fn().mockResolvedValue(true)
    const runDomainHealthCron = vi
      .fn()
      .mockResolvedValue(completed(["example.com"]))

    const result = await processPorkbunWebhookReceipts({
      claim: vi.fn().mockResolvedValue([ignored, relevant]),
      defer: vi.fn(),
      markDeadLettered: vi.fn().mockResolvedValue(true),
      markFailed: vi.fn().mockResolvedValue(true),
      markIgnored,
      markProcessed: vi.fn().mockResolvedValue(true),
      now: () => receivedAt,
      readMonitoredApexDomains: vi
        .fn()
        .mockResolvedValue(new Set(["example.com"])),
      runDomainHealthCron,
    })

    expect(markIgnored).toHaveBeenCalledWith(ignored)
    expect(runDomainHealthCron).toHaveBeenCalledWith(new Set(["example.com"]))
    expect(result.forcedApexDomains).toEqual(["example.com"])
  })

  it("dead-letters a repeatedly failing receipt at the attempt bound", async () => {
    const pending = receipt({
      attemptCount: PORKBUN_WEBHOOK_RECEIPT_MAX_ATTEMPTS,
    })
    const markDeadLettered = vi.fn().mockResolvedValue(true)
    const markFailed = vi.fn()

    await processPorkbunWebhookReceipts({
      claim: vi.fn().mockResolvedValue([pending]),
      defer: vi.fn(),
      markDeadLettered,
      markFailed,
      markIgnored: vi.fn().mockResolvedValue(true),
      markProcessed: vi.fn(),
      now: () => receivedAt,
      readMonitoredApexDomains: vi
        .fn()
        .mockResolvedValue(new Set(["example.com"])),
      runDomainHealthCron: vi.fn().mockResolvedValue(completed()),
    })

    expect(markDeadLettered).toHaveBeenCalledWith(
      pending,
      "porkbun_refresh_not_confirmed"
    )
    expect(markFailed).not.toHaveBeenCalled()
  })
})
