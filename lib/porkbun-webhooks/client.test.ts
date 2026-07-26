import { describe, expect, it, vi } from "vitest"

import {
  PORKBUN_DOMAIN_WEBHOOK_EVENTS,
  PorkbunWebhookClient,
  type PorkbunWebhookFetcher,
} from "./client"

vi.mock("server-only", () => ({}))

const credentials = {
  PORKBUN_API_KEY: "public-key",
  PORKBUN_SECRET_KEY: "secret-key",
}

function response(
  document: unknown,
  status = 200,
  headers?: HeadersInit
): Response {
  return new Response(JSON.stringify(document), { headers, status })
}

function endpoint(overrides: Record<string, unknown> = {}) {
  return {
    consecutiveFailures: 0,
    createDate: "2026-07-26 12:00:00",
    events: [...PORKBUN_DOMAIN_WEBHOOK_EVENTS],
    id: 42,
    lastError: null,
    lastFailureDate: null,
    lastSuccessDate: "2026-07-26 12:01:00",
    secret: "generated-signing-secret",
    status: "ACTIVE",
    url: "https://pulse.example/api/webhooks/porkbun",
    ...overrides,
  }
}

function client(fetcher: PorkbunWebhookFetcher) {
  return new PorkbunWebhookClient({
    env: credentials,
    fetcher,
    idempotencyKey: () => "request-key",
  })
}

describe("PorkbunWebhookClient", () => {
  it("creates a HTTPS endpoint subscribed only to domain renewal and expiry", async () => {
    const fetcher = vi.fn<PorkbunWebhookFetcher>(async () =>
      response({ endpoint: endpoint(), status: "SUCCESS" }, 200, {
        "x-request-id": "porkbun-request",
      })
    )

    const result = await client(fetcher).createEndpoint(
      "https://pulse.example/api/webhooks/porkbun"
    )

    expect(result).toMatchObject({
      data: { secret: "generated-signing-secret" },
      outcome: "ok",
      requestId: "porkbun-request",
    })
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.porkbun.com/api/json/v3/webhook/create",
      expect.objectContaining({
        body: JSON.stringify({
          events: PORKBUN_DOMAIN_WEBHOOK_EVENTS,
          url: "https://pulse.example/api/webhooks/porkbun",
        }),
        headers: expect.objectContaining({
          "Idempotency-Key": "request-key",
          "X-API-Key": "public-key",
          "X-Secret-API-Key": "secret-key",
        }),
        method: "POST",
      })
    )
  })

  it("rejects non-HTTPS URLs before contacting Porkbun", async () => {
    const fetcher = vi.fn<PorkbunWebhookFetcher>()

    await expect(
      client(fetcher).createEndpoint("http://pulse.example/hook")
    ).resolves.toEqual({
      code: "INVALID_WEBHOOK_URL",
      httpStatus: null,
      outcome: "failed",
      reason: "http",
      requestId: null,
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("updates status and URL while retaining the exact domain event contract", async () => {
    const fetcher = vi.fn<PorkbunWebhookFetcher>(async () =>
      response({
        endpoint: endpoint({ status: "DISABLED" }),
        status: "SUCCESS",
      })
    )

    await client(fetcher).updateEndpoint({
      id: 42,
      status: "DISABLED",
      url: "https://pulse.example/api/webhooks/new-porkbun",
    })

    const request = fetcher.mock.calls[0]?.[1]
    expect(request?.body).toBe(
      JSON.stringify({
        events: PORKBUN_DOMAIN_WEBHOOK_EVENTS,
        id: 42,
        status: "DISABLED",
        url: "https://pulse.example/api/webhooks/new-porkbun",
      })
    )
    expect(new Headers(request?.headers).get("Idempotency-Key")).toBe(
      "request-key"
    )
  })

  it("preserves a missing webhook's HTTP status when updating", async () => {
    const result = await client(async () =>
      response({ code: "WEBHOOK_NOT_FOUND", status: "ERROR" }, 404, {
        "x-request-id": "porkbun-request",
      })
    ).updateEndpoint({ id: 42, status: "ACTIVE" })

    expect(result).toEqual({
      code: "WEBHOOK_NOT_FOUND",
      httpStatus: 404,
      outcome: "failed",
      reason: "http",
      requestId: "porkbun-request",
    })
  })

  it("lists endpoints with header authentication and no request body", async () => {
    const fetcher = vi.fn<PorkbunWebhookFetcher>(async () =>
      response({ endpoints: [endpoint()], status: "SUCCESS" })
    )

    const result = await client(fetcher).listEndpoints()

    expect(result).toMatchObject({
      outcome: "ok",
      data: [expect.objectContaining({ id: 42 })],
    })
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.porkbun.com/api/json/v3/webhook/list",
      expect.objectContaining({ method: "GET" })
    )
    expect(fetcher.mock.calls[0]?.[1].body).toBeUndefined()
  })

  it("tests an endpoint and combines endpoint health with recent delivery attempts", async () => {
    const fetcher = vi
      .fn<PorkbunWebhookFetcher>()
      .mockResolvedValueOnce(
        response({ eventId: "event-1", status: "SUCCESS" })
      )
      .mockResolvedValueOnce(
        response({ endpoint: endpoint(), status: "SUCCESS" })
      )
      .mockResolvedValueOnce(
        response({
          deliveries: [
            {
              attempts: 1,
              createDate: "2026-07-26 12:02:00",
              deliveredDate: "2026-07-26 12:02:01",
              endpointId: 42,
              eventId: "event-1",
              eventType: "webhook.test",
              httpStatus: 204,
              id: 9001,
              lastError: null,
              maxAttempts: 6,
              nextAttemptAt: null,
              status: "DELIVERED",
            },
          ],
          status: "SUCCESS",
          total: 1,
        })
      )

    await expect(client(fetcher).testEndpoint(42)).resolves.toMatchObject({
      data: { eventId: "event-1" },
      outcome: "ok",
    })
    await expect(
      client(fetcher).inspectDeliveryHealth(42)
    ).resolves.toMatchObject({
      data: {
        deliveries: [expect.objectContaining({ status: "DELIVERED" })],
        endpoint: expect.objectContaining({ consecutiveFailures: 0 }),
        total: 1,
      },
      outcome: "ok",
    })
    expect(fetcher.mock.calls[2]?.[0]).toBe(
      "https://api.porkbun.com/api/json/v3/webhook/deliveries?endpointId=42&limit=50"
    )
  })

  it("does not request Porkbun without both credentials", async () => {
    const fetcher = vi.fn<PorkbunWebhookFetcher>()
    const missingSecret = new PorkbunWebhookClient({
      env: { PORKBUN_API_KEY: "public-key" },
      fetcher,
    })

    await expect(missingSecret.listEndpoints()).resolves.toEqual({
      outcome: "unconfigured",
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("classifies provider rate limits, HTTP errors, timeouts, and oversized bodies", async () => {
    await expect(
      client(async () =>
        response({ code: "RATE_LIMIT_EXCEEDED" }, 429, {
          "x-ratelimit-reset": "1800000000",
        })
      ).listEndpoints()
    ).resolves.toEqual({
      outcome: "rate-limited",
      requestId: null,
      retryAt: new Date("2027-01-15T08:00:00.000Z"),
    })
    await expect(
      client(async () =>
        response({ code: "INVALID_API_KEYS_001" }, 400)
      ).listEndpoints()
    ).resolves.toEqual({
      code: "INVALID_API_KEYS_001",
      httpStatus: 400,
      outcome: "failed",
      reason: "http",
      requestId: null,
    })
    await expect(
      client(async () => {
        throw new DOMException("timed out", "TimeoutError")
      }).listEndpoints()
    ).resolves.toEqual({
      code: null,
      httpStatus: null,
      outcome: "failed",
      reason: "timeout",
      requestId: null,
    })
    await expect(
      client(async () =>
        response({}, 200, { "content-length": String(1024 * 1024 + 1) })
      ).listEndpoints()
    ).resolves.toEqual({
      code: null,
      httpStatus: 200,
      outcome: "failed",
      reason: "oversized-response",
      requestId: null,
    })
  })
})
