import { afterEach, describe, expect, it, vi } from "vitest"

import { createResendSender, type NotificationProviderError } from "./provider"

describe("Resend notification provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("allows monitoring to start when email is intentionally unconfigured", async () => {
    const sender = createResendSender({ apiKey: "", from: "" })

    await expect(
      sender.send(
        {
          to: "ops@example.com",
          subject: "Outage",
          react: "Outage",
        },
        "notification-1"
      )
    ).rejects.toEqual(
      expect.objectContaining<Partial<NotificationProviderError>>({
        code: "email_not_configured",
        retryable: false,
      })
    )
  })

  it("forwards the delivery abort signal while preserving idempotency", async () => {
    const request = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ id: "email-1" }, { status: 200 })
    )
    vi.stubGlobal("fetch", request)
    const sender = createResendSender({
      apiKey: "re_test",
      from: "Pulse <pulse@example.com>",
    })
    const controller = new AbortController()

    await expect(
      sender.send(
        {
          to: "ops@example.com",
          subject: "Outage",
          react: "Outage",
        },
        "notification-1",
        controller.signal
      )
    ).resolves.toEqual({ providerMessageId: "email-1" })

    expect(request).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        signal: controller.signal,
        headers: expect.any(Headers),
      })
    )
    const init = request.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
      "notification-1"
    )
  })
})
