import type { SQL } from "drizzle-orm"
import { describe, expect, it, vi } from "vitest"

import type { DatabaseHandle } from "@/lib/db/client"
import type { PorkbunIntegrationState } from "@/lib/porkbun-webhooks/store"

import {
  checkPorkbunConnection,
  getDomainMonitoringData,
  managePorkbunWebhook,
  PORKBUN_WEBHOOK_PROVISIONING_LOCK_KEY,
  updateDomainMonitoringSettings,
  withPorkbunWebhookProvisioningLock,
} from "./porkbun-settings"

vi.mock("server-only", () => ({}))

const connected: PorkbunIntegrationState = {
  coveredDomainCount: 2,
  expiryAlertsEnabled: false,
  providerCheckedAt: new Date("2026-07-26T11:00:00.000Z"),
  providerLastErrorCode: null,
  providerLastSuccessAt: new Date("2026-07-26T11:00:00.000Z"),
  webhookId: null,
  webhookLastReceivedAt: null,
  webhookStatus: null,
  webhookUrl: null,
}

const lockHandle = {} as DatabaseHandle
const withTestWebhookLock = async <T>(
  work: (handle: DatabaseHandle) => Promise<T>
): Promise<T> => await work(lockHandle)

function sqlText(query: SQL): string {
  return query.queryChunks
    .map((chunk) => {
      if (chunk === undefined) {
        return ""
      }
      if (typeof chunk === "string") {
        return chunk
      }
      if ("value" in chunk && Array.isArray(chunk.value)) {
        return chunk.value.join("")
      }
      return ""
    })
    .join("")
}

function endpoint(overrides: Record<string, unknown> = {}) {
  return {
    consecutiveFailures: null,
    createDate: null,
    events: ["domain.renewed", "domain.expiring"],
    id: 9,
    lastError: null,
    lastFailureDate: null,
    lastSuccessDate: null,
    secret: "provider-secret",
    status: "ACTIVE" as const,
    url: "https://pulse.example/api/webhooks/porkbun",
    ...overrides,
  }
}

function providerFailure(httpStatus: number) {
  return {
    code: "PROVIDER_ERROR",
    httpStatus,
    outcome: "failed" as const,
    reason: "http" as const,
    requestId: null,
  }
}

describe("Porkbun settings service", () => {
  it("takes a transaction-scoped advisory lock before provisioning a webhook", async () => {
    const execute = vi.fn(async (_query: SQL) => undefined)
    const transaction = vi.fn(async (work) => await work({ execute }))
    await withPorkbunWebhookProvisioningLock(async () => "locked", {
      transaction,
    } as never)
    expect(transaction).toHaveBeenCalledOnce()
    const query = execute.mock.calls[0]?.[0]
    expect(sqlText(query!)).toContain("pg_advisory_xact_lock")
    expect(query!.queryChunks).toContain(PORKBUN_WEBHOOK_PROVISIONING_LOCK_KEY)
  })

  it("serializes only safe integration state", async () => {
    await expect(
      getDomainMonitoringData({
        dependencies: { readIntegration: async () => connected },
      })
    ).resolves.toEqual({
      coveredDomainCount: 2,
      expiryAlertsEnabled: false,
      lastSuccessAt: "2026-07-26T11:00:00.000Z",
      state: "CONNECTED",
      webhookStatus: "NOT_CONFIGURED",
    })
  })

  it("checks only the account portfolio and records safe provider health", async () => {
    const upsertIntegration = vi.fn(async (update) => ({
      ...connected,
      ...update,
      providerLastSuccessAt: update.providerLastSuccessAt ?? null,
    }))
    await expect(
      checkPorkbunConnection({
        dependencies: {
          fetchAccountDomains: async () => ({
            domains: [
              {
                apiAccess: true,
                autoRenew: true,
                domain: "example.com",
                expiresAt: null,
                notLocal: false,
                status: null,
              },
              {
                apiAccess: true,
                autoRenew: true,
                domain: "external.example",
                expiresAt: null,
                notLocal: true,
                status: null,
              },
            ],
            outcome: "resolved",
          }),
          loadMonitors: async () => [
            { id: "one", url: "https://status.example.com" },
            { id: "two", url: "https://example.com" },
          ],
          now: () => new Date("2026-07-26T12:00:00.000Z"),
          readIntegration: async () => connected,
          upsertIntegration,
        },
      })
    ).resolves.toMatchObject({
      coveredDomainCount: 1,
      lastSuccessAt: "2026-07-26T12:00:00.000Z",
      state: "CONNECTED",
    })
    expect(upsertIntegration).toHaveBeenCalledWith({
      coveredDomainCount: 1,
      providerCheckedAt: new Date("2026-07-26T12:00:00.000Z"),
      providerLastErrorCode: null,
      providerLastSuccessAt: new Date("2026-07-26T12:00:00.000Z"),
    })
  })

  it("does not permit expiry alerts before the account is connected", async () => {
    await expect(
      updateDomainMonitoringSettings(
        { expiryAlertsEnabled: true },
        { dependencies: { readIntegration: async () => null } }
      )
    ).rejects.toMatchObject({ code: "PORKBUN_NOT_CONFIGURED" })
  })

  it("does not permit expiry alerts after a newer provider failure", async () => {
    await expect(
      updateDomainMonitoringSettings(
        { expiryAlertsEnabled: true },
        {
          dependencies: {
            readIntegration: async () => ({
              ...connected,
              providerLastErrorCode: "NETWORK",
            }),
          },
        }
      )
    ).rejects.toMatchObject({ code: "PORKBUN_NOT_CONFIGURED" })
  })

  it("allows alerts to be disabled while provider health needs attention", async () => {
    const upsertIntegration = vi.fn(async (update) => ({
      ...connected,
      ...update,
      providerLastErrorCode: "NETWORK",
    }))
    await expect(
      updateDomainMonitoringSettings(
        { expiryAlertsEnabled: false },
        {
          dependencies: {
            readIntegration: async () => ({
              ...connected,
              expiryAlertsEnabled: true,
              providerLastErrorCode: "NETWORK",
            }),
            upsertIntegration,
          },
        }
      )
    ).resolves.toMatchObject({ expiryAlertsEnabled: false })
    expect(upsertIntegration).toHaveBeenCalledWith(
      { expiryAlertsEnabled: false },
      undefined
    )
  })

  it("marks an active webhook failing when recent delivery health failed", async () => {
    const upsertIntegration = vi.fn(async (update) => ({
      ...connected,
      ...update,
    }))
    await checkPorkbunConnection({
      dependencies: {
        fetchAccountDomains: async () => ({ domains: [], outcome: "resolved" }),
        loadMonitors: async () => [],
        readIntegration: async () => ({ ...connected, webhookId: 9 }),
        upsertIntegration,
        webhookClient: {
          createEndpoint: vi.fn(),
          inspectDeliveryHealth: async () => ({
            data: {
              deliveries: [
                {
                  attempts: 1,
                  createDate: null,
                  deliveredDate: null,
                  endpointId: 9,
                  eventId: "event-1",
                  eventType: "domain.expiring",
                  httpStatus: 500,
                  id: 10,
                  lastError: "failed",
                  maxAttempts: 3,
                  nextAttemptAt: null,
                  status: "FAILED" as const,
                },
              ],
              endpoint: endpoint(),
              total: 1,
            },
            outcome: "ok" as const,
            requestId: null,
          }),
          listEndpoints: vi.fn(),
          testEndpoint: vi.fn(),
          updateEndpoint: vi.fn(),
        },
      },
    })
    expect(upsertIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ webhookStatus: "FAILING" })
    )
  })

  it("keeps a latest provider error visible after an earlier successful check", async () => {
    await expect(
      getDomainMonitoringData({
        dependencies: {
          readIntegration: async () => ({
            ...connected,
            providerLastErrorCode: "NETWORK",
          }),
        },
      })
    ).resolves.toMatchObject({ state: "NEEDS_ATTENTION" })
  })

  it("serializes an intentionally disabled webhook as not configured", async () => {
    await expect(
      getDomainMonitoringData({
        dependencies: {
          readIntegration: async () => ({
            ...connected,
            webhookStatus: "DISABLED",
          }),
        },
      })
    ).resolves.toMatchObject({ webhookStatus: "NOT_CONFIGURED" })
  })

  it("enables the exact HTTPS callback and persists no displayable secret", async () => {
    const previous = process.env.NEXT_PUBLIC_APP_URL
    process.env.NEXT_PUBLIC_APP_URL = "https://pulse.example"
    const upsertIntegration = vi.fn(async (update) => ({
      ...connected,
      ...update,
      webhookLastReceivedAt: null,
    }))
    const createEndpoint = vi.fn(async () => ({
      outcome: "ok" as const,
      data: endpoint(),
      requestId: null,
    }))
    try {
      await expect(
        managePorkbunWebhook("enable", {
          dependencies: {
            readIntegration: async () => connected,
            upsertIntegration,
            withWebhookProvisioningLock: withTestWebhookLock,
            webhookClient: {
              createEndpoint,
              inspectDeliveryHealth: vi.fn(),
              listEndpoints: async () => ({
                outcome: "ok",
                data: [],
                requestId: null,
              }),
              testEndpoint: vi.fn(),
              updateEndpoint: vi.fn(),
            },
          },
        })
      ).resolves.toEqual({
        coveredDomainCount: 2,
        expiryAlertsEnabled: false,
        lastSuccessAt: "2026-07-26T11:00:00.000Z",
        state: "CONNECTED",
        webhookStatus: "ACTIVE",
      })
      expect(createEndpoint).toHaveBeenCalledWith(
        "https://pulse.example/api/webhooks/porkbun"
      )
      expect(upsertIntegration).toHaveBeenCalledWith(
        expect.objectContaining({
          webhookId: 9,
          webhookSecret: "provider-secret",
          webhookStatus: "ACTIVE",
        }),
        { handle: lockHandle }
      )
    } finally {
      process.env.NEXT_PUBLIC_APP_URL = previous
    }
  })

  it("updates an exact callback before enabling it so its events remain domain-only", async () => {
    const previous = process.env.NEXT_PUBLIC_APP_URL
    process.env.NEXT_PUBLIC_APP_URL = "https://pulse.example"
    const updateEndpoint = vi.fn(async () => ({
      outcome: "ok" as const,
      data: endpoint(),
      requestId: null,
    }))
    try {
      await managePorkbunWebhook("enable", {
        dependencies: {
          readIntegration: async () => connected,
          upsertIntegration: async (update) => ({ ...connected, ...update }),
          withWebhookProvisioningLock: withTestWebhookLock,
          webhookClient: {
            createEndpoint: vi.fn(),
            inspectDeliveryHealth: vi.fn(),
            listEndpoints: async () => ({
              outcome: "ok",
              data: [endpoint({ status: "DISABLED" })],
              requestId: null,
            }),
            testEndpoint: vi.fn(),
            updateEndpoint,
          },
        },
      })
      expect(updateEndpoint).toHaveBeenCalledWith({
        id: 9,
        status: "ACTIVE",
        url: "https://pulse.example/api/webhooks/porkbun",
      })
    } finally {
      process.env.NEXT_PUBLIC_APP_URL = previous
    }
  })

  it("updates the stored endpoint when the callback changes without creating another", async () => {
    const previous = process.env.NEXT_PUBLIC_APP_URL
    process.env.NEXT_PUBLIC_APP_URL = "https://new-pulse.example"
    const createEndpoint = vi.fn()
    const updateEndpoint = vi.fn(async () => ({
      outcome: "ok" as const,
      data: endpoint({ url: "https://new-pulse.example/api/webhooks/porkbun" }),
      requestId: null,
    }))
    const upsertIntegration = vi.fn(async (update) => ({
      ...connected,
      ...update,
      webhookId: 9,
    }))
    const readIntegration = vi.fn(async () => ({
      ...connected,
      webhookId: 9,
      webhookStatus: "ACTIVE" as const,
      webhookUrl: "https://old-pulse.example/api/webhooks/porkbun",
    }))
    try {
      await managePorkbunWebhook("enable", {
        dependencies: {
          readIntegration,
          upsertIntegration,
          withWebhookProvisioningLock: withTestWebhookLock,
          webhookClient: {
            createEndpoint,
            inspectDeliveryHealth: vi.fn(),
            listEndpoints: vi.fn(),
            testEndpoint: vi.fn(),
            updateEndpoint,
          },
        },
      })
      expect(updateEndpoint).toHaveBeenCalledWith({
        id: 9,
        status: "ACTIVE",
        url: "https://new-pulse.example/api/webhooks/porkbun",
      })
      expect(createEndpoint).not.toHaveBeenCalled()
      expect(readIntegration).toHaveBeenCalledWith(lockHandle)
      expect(upsertIntegration).toHaveBeenCalledWith(
        expect.objectContaining({
          webhookId: 9,
          webhookSecret: "provider-secret",
        }),
        { handle: lockHandle }
      )
    } finally {
      process.env.NEXT_PUBLIC_APP_URL = previous
    }
  })

  it("uses the same serialization boundary for test, disable, and enable actions", async () => {
    let lockCalls = 0
    const withWebhookProvisioningLock = async <T>(
      work: (handle: DatabaseHandle) => Promise<T>
    ): Promise<T> => {
      lockCalls += 1
      return await withTestWebhookLock(work)
    }
    const readIntegration = vi.fn(async () => ({ ...connected, webhookId: 9 }))
    const upsertIntegration = vi.fn(async (update) => ({
      ...connected,
      ...update,
    }))
    const webhookClient = {
      createEndpoint: vi.fn(async () => ({
        outcome: "ok" as const,
        data: endpoint(),
        requestId: null,
      })),
      inspectDeliveryHealth: vi.fn(),
      listEndpoints: vi.fn(async () => ({
        outcome: "ok" as const,
        data: [],
        requestId: null,
      })),
      testEndpoint: vi.fn(async () => ({
        outcome: "ok" as const,
        data: { eventId: "event-1" },
        requestId: null,
      })),
      updateEndpoint: vi.fn(async (input: { status?: string }) => ({
        outcome: "ok" as const,
        data: endpoint({
          status: input.status === "DISABLED" ? "DISABLED" : "ACTIVE",
        }),
        requestId: null,
      })),
    }
    const previous = process.env.NEXT_PUBLIC_APP_URL
    process.env.NEXT_PUBLIC_APP_URL = "https://pulse.example"
    try {
      await Promise.all(
        (["test", "disable", "enable"] as const).map((action) =>
          managePorkbunWebhook(action, {
            dependencies: {
              readIntegration,
              upsertIntegration,
              webhookClient,
              withWebhookProvisioningLock,
            },
          })
        )
      )
      expect(lockCalls).toBe(3)
      expect(readIntegration).toHaveBeenCalledWith(lockHandle)
      expect(upsertIntegration).toHaveBeenCalledWith(
        expect.objectContaining({ webhookStatus: "DISABLED" }),
        { handle: lockHandle }
      )
    } finally {
      process.env.NEXT_PUBLIC_APP_URL = previous
    }
  })

  it("recovers a confirmed missing stored endpoint under the lock", async () => {
    const previous = process.env.NEXT_PUBLIC_APP_URL
    process.env.NEXT_PUBLIC_APP_URL = "https://pulse.example"
    const createEndpoint = vi.fn(async () => ({
      outcome: "ok" as const,
      data: endpoint({ id: 17, secret: "replacement-secret" }),
      requestId: null,
    }))
    const listEndpoints = vi.fn(async () => ({
      outcome: "ok" as const,
      data: [],
      requestId: null,
    }))
    const updateEndpoint = vi.fn(async () => providerFailure(404))
    const upsertIntegration = vi.fn(async (update) => ({
      ...connected,
      ...update,
    }))
    try {
      await managePorkbunWebhook("enable", {
        dependencies: {
          readIntegration: async () => ({ ...connected, webhookId: 9 }),
          upsertIntegration,
          withWebhookProvisioningLock: withTestWebhookLock,
          webhookClient: {
            createEndpoint,
            inspectDeliveryHealth: vi.fn(),
            listEndpoints,
            testEndpoint: vi.fn(),
            updateEndpoint,
          },
        },
      })
      expect(listEndpoints).toHaveBeenCalledOnce()
      expect(createEndpoint).toHaveBeenCalledWith(
        "https://pulse.example/api/webhooks/porkbun"
      )
      expect(upsertIntegration).toHaveBeenCalledWith(
        expect.objectContaining({
          webhookId: 17,
          webhookSecret: "replacement-secret",
        }),
        { handle: lockHandle }
      )
    } finally {
      process.env.NEXT_PUBLIC_APP_URL = previous
    }
  })

  it("fails closed for a non-404 stored endpoint update failure", async () => {
    const previous = process.env.NEXT_PUBLIC_APP_URL
    process.env.NEXT_PUBLIC_APP_URL = "https://pulse.example"
    const createEndpoint = vi.fn()
    const listEndpoints = vi.fn()
    const upsertIntegration = vi.fn()
    try {
      await expect(
        managePorkbunWebhook("enable", {
          dependencies: {
            readIntegration: async () => ({ ...connected, webhookId: 9 }),
            upsertIntegration,
            withWebhookProvisioningLock: withTestWebhookLock,
            webhookClient: {
              createEndpoint,
              inspectDeliveryHealth: vi.fn(),
              listEndpoints,
              testEndpoint: vi.fn(),
              updateEndpoint: async () => providerFailure(500),
            },
          },
        })
      ).rejects.toMatchObject({ code: "PORKBUN_UNAVAILABLE" })
      expect(listEndpoints).not.toHaveBeenCalled()
      expect(createEndpoint).not.toHaveBeenCalled()
      expect(upsertIntegration).not.toHaveBeenCalled()
    } finally {
      process.env.NEXT_PUBLIC_APP_URL = previous
    }
  })
})
