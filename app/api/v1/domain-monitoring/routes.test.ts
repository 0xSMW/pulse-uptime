import { beforeEach, describe, expect, it, vi } from "vitest"

const completed = vi.hoisted(
  () => new Map<string, { status: number; body: unknown }>()
)

vi.mock("server-only", () => ({}))
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/api/live-authority", () => ({ hasLiveScope: vi.fn() }))
vi.mock("@/lib/db/client", () => ({
  db: { transaction: vi.fn(async (work) => await work("stub-tx")) },
}))
vi.mock("@/lib/api/idempotency", () => ({
  executeIdempotent: vi.fn(async ({ request: idempotencyRequest, work }) => {
    const key = idempotencyRequest.headers.get("idempotency-key") ?? ""
    const replayed = completed.get(key)
    if (replayed) {
      return { ...replayed, replayed: true }
    }
    const result = await work("stub-tx")
    completed.set(key, result)
    return { ...result, replayed: false }
  }),
}))
vi.mock("@/lib/domain-health/porkbun-settings", () => ({
  checkPorkbunConnection: vi.fn(),
  DomainMonitoringError: class StubDomainMonitoringError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  },
  managePorkbunWebhook: vi.fn(),
  updateDomainMonitoringSettings: vi.fn(),
}))

import { executeIdempotent } from "@/lib/api/idempotency"
import { hasLiveScope } from "@/lib/api/live-authority"
import { type ApiContext, authorize } from "@/lib/api/middleware"
import { db } from "@/lib/db/client"
import {
  checkPorkbunConnection,
  DomainMonitoringError,
  managePorkbunWebhook,
  updateDomainMonitoringSettings,
} from "@/lib/domain-health/porkbun-settings"

import { POST as check } from "./check/route"
import { PATCH as settings } from "./settings/route"
import { POST as webhook } from "./webhook/route"

const data = {
  coveredDomainCount: 1,
  expiryAlertsEnabled: false,
  lastSuccessAt: "2026-07-26T12:00:00.000Z",
  state: "CONNECTED" as const,
  webhookStatus: "NOT_CONFIGURED" as const,
}

const context: ApiContext = {
  principal: {
    type: "api_token",
    id: "token-1",
    name: "admin",
    scopes: ["config:write"],
    expiresAt: new Date(),
  },
  principalKey: "api_token:token-1",
  requestId: "req_domain_monitoring",
}

function request(
  path: string,
  body?: unknown,
  idempotencyKey = crypto.randomUUID()
) {
  return new Request(`https://pulse.test${path}`, {
    method: path.endsWith("settings") ? "PATCH" : "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

beforeEach(() => {
  completed.clear()
  vi.mocked(authorize).mockResolvedValue(context)
  vi.mocked(executeIdempotent).mockClear()
  vi.mocked(hasLiveScope).mockReset().mockResolvedValue(true)
  vi.mocked(db.transaction).mockClear()
  vi.mocked(checkPorkbunConnection).mockReset().mockResolvedValue(data)
  vi.mocked(managePorkbunWebhook).mockReset().mockResolvedValue(data)
  vi.mocked(updateDomainMonitoringSettings).mockReset().mockResolvedValue(data)
})

describe("domain monitoring API", () => {
  it.each([
    [
      "settings",
      () =>
        settings(
          request("/api/v1/domain-monitoring/settings", {
            expiryAlertsEnabled: true,
          })
        ),
    ],
    ["check", () => check(request("/api/v1/domain-monitoring/check"))],
    [
      "webhook",
      () =>
        webhook(
          request("/api/v1/domain-monitoring/webhook", { action: "enable" })
        ),
    ],
  ])(
    "stops revoked authority before %s side effects and completes the idempotency result",
    async (_name, run) => {
      vi.mocked(hasLiveScope).mockResolvedValue(false)

      const response = await run()

      expect(response.status).toBe(403)
      expect((await response.json()).error.code).toBe("AUTHORIZATION_REVOKED")
      expect(hasLiveScope).toHaveBeenCalledWith(
        "stub-tx",
        context.principal,
        "config:write"
      )
      expect(checkPorkbunConnection).not.toHaveBeenCalled()
      expect(managePorkbunWebhook).not.toHaveBeenCalled()
      expect(updateDomainMonitoringSettings).not.toHaveBeenCalled()
      expect([...completed.values()][0]).toMatchObject({
        status: 403,
        body: { error: { code: "AUTHORIZATION_REVOKED" } },
      })
    }
  )

  it("protects the settings mutation with config:write and atomic idempotency", async () => {
    const response = await settings(
      request("/api/v1/domain-monitoring/settings", {
        expiryAlertsEnabled: true,
      })
    )
    expect(response.status).toBe(200)
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), {
      scope: "config:write",
    })
    expect(updateDomainMonitoringSettings).toHaveBeenCalledWith(
      { expiryAlertsEnabled: true },
      { handle: "stub-tx" }
    )
    expect(vi.mocked(executeIdempotent).mock.calls[0]?.[0]).toMatchObject({
      mode: "atomic",
      routeKey: "/api/v1/domain-monitoring/settings",
    })
  })

  it("uses the UI check contract and persists it through idempotency", async () => {
    const response = await check(request("/api/v1/domain-monitoring/check"))
    expect(response.status).toBe(200)
    expect(checkPorkbunConnection).toHaveBeenCalledOnce()
    expect(checkPorkbunConnection).toHaveBeenCalledWith({ handle: "stub-tx" })
    expect(vi.mocked(executeIdempotent).mock.calls[0]?.[0]).toMatchObject({
      body: {},
      mode: "conservative",
      routeKey: "/api/v1/domain-monitoring/check",
    })
    expect((await response.json()).data).toEqual(data)
  })

  it("accepts only named webhook actions and never returns provider details", async () => {
    const response = await webhook(
      request("/api/v1/domain-monitoring/webhook", { action: "enable" })
    )
    expect(response.status).toBe(200)
    expect(managePorkbunWebhook).toHaveBeenCalledWith("enable", {
      handle: "stub-tx",
    })
    expect((await response.json()).data).toEqual(data)

    const invalid = await webhook(
      request("/api/v1/domain-monitoring/webhook", { action: "other" })
    )
    expect(invalid.status).toBe(400)
    expect(managePorkbunWebhook).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      "settings",
      () =>
        settings(
          request(
            "/api/v1/domain-monitoring/settings",
            { expiryAlertsEnabled: true },
            "retry-key"
          )
        ),
      updateDomainMonitoringSettings,
      "PORKBUN_NOT_CONFIGURED",
      409,
    ],
    [
      "check",
      () =>
        check(
          request("/api/v1/domain-monitoring/check", undefined, "retry-key")
        ),
      checkPorkbunConnection,
      "PORKBUN_UNAVAILABLE",
      503,
    ],
    [
      "webhook",
      () =>
        webhook(
          request(
            "/api/v1/domain-monitoring/webhook",
            { action: "enable" },
            "retry-key"
          )
        ),
      managePorkbunWebhook,
      "WEBHOOK_NOT_CONFIGURED",
      409,
    ],
  ] as const)(
    "completes and replays a %s domain error instead of leaving a running key",
    async (_name, run, service, code, status) => {
      vi.mocked(service).mockRejectedValue(
        new DomainMonitoringError(code, "unavailable")
      )

      const first = await run()
      expect(first.status).toBe(status)
      expect((await first.json()).error.code).toBe(code)
      expect(completed.get("retry-key")).toMatchObject({ status })

      const replay = await run()
      expect(replay.status).toBe(status)
      expect(replay.headers.get("Idempotency-Replayed")).toBe("true")
      expect(service).toHaveBeenCalledOnce()
    }
  )
})
