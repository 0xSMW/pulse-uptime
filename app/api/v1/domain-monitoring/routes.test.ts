import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/api/idempotency", () => ({
  executeIdempotent: vi.fn(async ({ work }) => ({
    ...(await work("stub-tx")),
    replayed: false,
  })),
}))
vi.mock("@/lib/domain-health/porkbun-settings", () => ({
  checkPorkbunConnection: vi.fn(),
  DomainMonitoringError: class DomainMonitoringError extends Error {},
  managePorkbunWebhook: vi.fn(),
  updateDomainMonitoringSettings: vi.fn(),
}))

import { executeIdempotent } from "@/lib/api/idempotency"
import { type ApiContext, authorize } from "@/lib/api/middleware"
import {
  checkPorkbunConnection,
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

function request(path: string, body?: unknown) {
  return new Request(`https://pulse.test${path}`, {
    method: path.endsWith("settings") ? "PATCH" : "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

beforeEach(() => {
  vi.mocked(authorize).mockResolvedValue(context)
  vi.mocked(executeIdempotent).mockClear()
  vi.mocked(checkPorkbunConnection).mockResolvedValue(data)
  vi.mocked(managePorkbunWebhook).mockResolvedValue(data)
  vi.mocked(updateDomainMonitoringSettings).mockResolvedValue(data)
})

describe("domain monitoring API", () => {
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
    expect(managePorkbunWebhook).toHaveBeenCalledWith("enable")
    expect((await response.json()).data).toEqual(data)

    const invalid = await webhook(
      request("/api/v1/domain-monitoring/webhook", { action: "other" })
    )
    expect(invalid.status).toBe(400)
    expect(managePorkbunWebhook).toHaveBeenCalledTimes(1)
  })
})
