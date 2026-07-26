import { createHash, createHmac } from "node:crypto"

import { describe, expect, it, vi } from "vitest"

import {
  PORKBUN_MAX_WEBHOOK_BODY_BYTES,
  PORKBUN_REPLAY_WINDOW_SECONDS,
  type PorkbunWebhookReceiverDependencies,
  receivePorkbunWebhook,
} from "./receiver"

const secret = "porkbun-webhook-secret"
const now = new Date("2026-07-26T12:00:00Z")
const timestamp = String(Math.floor(now.getTime() / 1000))

function signedRequest(
  payload: Record<string, unknown>,
  options: Partial<{
    event: string
    id: string
    signature: string
    timestamp: string
  }> = {}
): Request {
  const rawBody = JSON.stringify(payload)
  const requestTimestamp = options.timestamp ?? timestamp
  const signature =
    options.signature ??
    `sha256=${createHmac("sha256", secret)
      .update(`${requestTimestamp}.${rawBody}`)
      .digest("hex")}`
  return new Request("https://pulse.test/api/webhooks/porkbun", {
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "x-porkbun-event": options.event ?? String(payload.event),
      "x-porkbun-signature": signature,
      "x-porkbun-webhook-id": options.id ?? String(payload.id),
      "x-porkbun-webhook-timestamp": requestTimestamp,
    },
    method: "POST",
  })
}

function dependencies(
  overrides: Partial<PorkbunWebhookReceiverDependencies> = {}
): PorkbunWebhookReceiverDependencies {
  return {
    now: () => now,
    persistence: { record: vi.fn().mockResolvedValue({ duplicate: false }) },
    signingSecret: secret,
    ...overrides,
  }
}

const renewed = {
  createdAt: "2026-07-26T11:59:59Z",
  data: {
    domain: "Example.COM",
    expireDate: "2027-07-26 00:00:00",
    tld: "com",
  },
  event: "domain.renewed",
  id: "019c4a2e-0000-7000-8000-000000000001",
}

describe("receivePorkbunWebhook", () => {
  it("verifies and durably records a renewed domain for later refresh", async () => {
    const deps = dependencies()

    const response = await receivePorkbunWebhook(signedRequest(renewed), deps)

    expect(response.status).toBe(204)
    expect(deps.persistence.record).toHaveBeenCalledWith({
      domain: "example.com",
      event: "domain.renewed",
      eventCreatedAt: renewed.createdAt,
      eventId: renewed.id,
      expireDate: "2027-07-26 00:00:00",
      payloadDigest: createHash("sha256")
        .update(JSON.stringify(renewed))
        .digest("hex"),
    })
  })

  it("durably records a verified test event without a domain", async () => {
    const deps = dependencies()
    const payload = { ...renewed, data: {}, event: "webhook.test" }

    const response = await receivePorkbunWebhook(signedRequest(payload), deps)

    expect(response.status).toBe(204)
    expect(deps.persistence.record).toHaveBeenCalledWith({
      domain: null,
      event: "webhook.test",
      eventCreatedAt: payload.createdAt,
      eventId: payload.id,
      expireDate: null,
      payloadDigest: createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex"),
    })
  })

  it("rejects invalid signatures before persistence or refresh", async () => {
    const deps = dependencies()

    const response = await receivePorkbunWebhook(
      signedRequest(renewed, { signature: "sha256=wrong" }),
      deps
    )

    expect(response.status).toBe(400)
    expect(deps.persistence.record).not.toHaveBeenCalled()
  })

  it("rejects timestamps outside the replay window", async () => {
    const deps = dependencies()
    const staleTimestamp = String(
      Number(timestamp) - PORKBUN_REPLAY_WINDOW_SECONDS - 1
    )

    const response = await receivePorkbunWebhook(
      signedRequest(renewed, { timestamp: staleTimestamp }),
      deps
    )

    expect(response.status).toBe(400)
  })

  it("rejects bodies over 64 KiB before signature verification or persistence", async () => {
    const deps = dependencies()
    const payload = {
      ...renewed,
      data: {
        domain: "example.com",
        padding: "x".repeat(PORKBUN_MAX_WEBHOOK_BODY_BYTES),
      },
    }

    const response = await receivePorkbunWebhook(signedRequest(payload), deps)

    expect(response.status).toBe(413)
    expect(deps.persistence.record).not.toHaveBeenCalled()
  })

  it("rejects invalid event creation timestamps before persistence", async () => {
    const deps = dependencies()
    const payload = { ...renewed, createdAt: "not-a-timestamp" }

    const response = await receivePorkbunWebhook(signedRequest(payload), deps)

    expect(response.status).toBe(400)
    expect(deps.persistence.record).not.toHaveBeenCalled()
  })

  it("uses the injected persistence boundary to acknowledge duplicates", async () => {
    const record = vi.fn().mockResolvedValue({ duplicate: true })
    const deps = dependencies({ persistence: { record } })

    const response = await receivePorkbunWebhook(signedRequest(renewed), deps)

    expect(response.status).toBe(200)
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: renewed.id })
    )
  })

  it("rejects a payload whose signed event does not match its header", async () => {
    const deps = dependencies()

    const response = await receivePorkbunWebhook(
      signedRequest(renewed, { event: "domain.expiring" }),
      deps
    )

    expect(response.status).toBe(400)
  })

  it("rejects event types outside the domain refresh contract", async () => {
    const deps = dependencies()
    const payload = { ...renewed, event: "dns.record.updated" }

    const response = await receivePorkbunWebhook(signedRequest(payload), deps)

    expect(response.status).toBe(400)
    expect(deps.persistence.record).not.toHaveBeenCalled()
  })
})
