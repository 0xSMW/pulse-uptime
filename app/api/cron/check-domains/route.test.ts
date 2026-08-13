import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const { processPorkbunWebhookReceipts } = vi.hoisted(() => ({
  processPorkbunWebhookReceipts: vi.fn(),
}))

vi.mock("@/lib/porkbun-webhooks/runtime", () => ({
  processPorkbunWebhookReceipts,
}))

import { GET } from "./route"

function logObject(spy: ReturnType<typeof vi.spyOn>, call: number) {
  return JSON.parse(String(spy.mock.calls[call]?.[0])) as Record<
    string,
    unknown
  >
}

describe("domain cron route", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret"
    process.env.PULSE_RELEASE_ID = "release-domains"
  })

  afterEach(() => {
    vi.restoreAllMocks()
    processPorkbunWebhookReceipts.mockReset()
    delete process.env.CRON_SECRET
    delete process.env.PULSE_RELEASE_ID
  })

  it("preserves the synthetic failure when webhook processing throws", async () => {
    processPorkbunWebhookReceipts.mockRejectedValue(new Error("database down"))
    vi.spyOn(Date, "now").mockReturnValueOnce(5000).mockReturnValueOnce(5060)
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)

    const response = await GET(
      new Request("https://pulse.test/api/cron/check-domains", {
        headers: { authorization: "Bearer cron-secret" },
      })
    )

    const result = {
      status: "failed",
      runId: "webhook-receipt-processing",
      error: "webhook_receipt_processing_failed",
    }
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual(result)
    expect(logObject(info, 0)).toEqual({
      event: "cron.started",
      jobName: "check-domains",
      releaseId: "release-domains",
    })
    expect(logObject(error, 0)).toEqual({
      event: "cron.failed",
      jobName: "check-domains",
      releaseId: "release-domains",
      status: "failed",
      errorCode: "webhook_receipt_processing_failed",
      runId: "webhook-receipt-processing",
      durationMs: 60,
    })
  })
})
