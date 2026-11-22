import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  type ConfigurationApplyRequest,
  DEFAULT_MONITOR_SETTINGS,
  hashMonitoringConfig,
  type MonitoringConfig,
} from "@/lib/config"

import {
  type ConfigurationStore,
  createConfigurationService,
} from "./config-service"
import type { Principal } from "./principal"
import type { ApiScope } from "./scopes"

const humanPrincipal: Principal = {
  type: "human",
  id: "admin",
  sessionId: "session-1",
  email: "admin@example.com",
  role: "admin",
  scopes: ["config:write"],
}

const current: MonitoringConfig = {
  schemaVersion: 2,
  configVersion: 4,
  settings: { ...DEFAULT_MONITOR_SETTINGS },
  groups: [],
  monitors: [],
}
const currentHash = hashMonitoringConfig(current)

function makeStore(
  hasLiveScope: (
    principal: Principal,
    scope: ApiScope
  ) => Promise<boolean> = async () => true,
  events: string[] = []
): ConfigurationStore {
  return {
    readAccepted: vi.fn(async () => ({ config: current, hash: currentHash })),
    transaction: async (work) =>
      await work({
        hasLiveScope: async (principal, scope) => {
          events.push(`live authority:${scope}`)
          return await hasLiveScope(principal, scope)
        },
        lockConfiguration: vi.fn(async () => {
          events.push("configuration lock")
        }),
        readAccepted: vi.fn(async () => ({
          config: current,
          hash: currentHash,
        })),
        findOperation: vi.fn(async () => null),
        insertApproval: vi.fn(async () => undefined),
        insertOperation: vi.fn(async (value) => ({
          id: "operation-1",
          baseConfigHash: value.baseConfigHash,
          targetConfigHash: value.targetConfigHash,
          planHash: value.planHash,
          state: "written" as const,
          edgeConfigVersion: value.edgeConfigVersion ?? null,
          rejectionReason: null,
          createdAt: (value.createdAt as Date).toISOString(),
          writtenAt: (value.writtenAt as Date).toISOString(),
          acceptedAt: null,
          failedAt: null,
        })),
      }),
    readOperation: vi.fn(async () => null),
  }
}

describe("configuration service seams", () => {
  it("uses the injected store and writes the complete normalized target through the injected Edge writer", async () => {
    const events: string[] = []
    const store = makeStore(async () => true, events)
    const writeEdgeConfig = vi.fn(async () => {
      events.push("edge write")
      return { version: 42 }
    })
    const service = createConfigurationService({ store, writeEdgeConfig })
    const targetConfig = {
      version: 2 as const,
      settings: { ...DEFAULT_MONITOR_SETTINGS },
      groups: [],
      monitors: [],
    }
    const plan = await service.plan({
      baseConfigHash: currentHash,
      targetConfig,
    })
    const request: ConfigurationApplyRequest = {
      ...plan,
      targetConfig,
      allowDestructiveChanges: false,
    }

    const operation = await service.apply({
      principal: humanPrincipal,
      principalKey: "human:admin",
      requestId: "req-1",
      idempotencyKey: "key-1",
      ifMatch: `"${currentHash}"`,
      request,
    })

    expect(writeEdgeConfig).toHaveBeenCalledWith({
      ...current,
      configVersion: 5,
    })
    expect(events).toEqual([
      "live authority:config:write",
      "configuration lock",
      "edge write",
    ])
    expect(operation).toMatchObject({
      id: "operation-1",
      state: "written",
      edgeConfigVersion: 42,
      targetConfigHash: plan.targetConfigHash,
    })
  })

  it.each<Principal>([
    humanPrincipal,
    {
      type: "api_token",
      id: "token-1",
      name: "automation",
      scopes: ["config:write"],
      expiresAt: new Date("2030-01-01"),
    },
    {
      type: "cli_session",
      id: "cli-1",
      email: "admin@example.com",
      scopes: ["config:write"],
      expiresAt: new Date("2030-01-01"),
      installation: {
        id: "installation-1",
        displayName: "laptop",
        platform: "darwin",
        architecture: "arm64",
        clientVersion: "1.0.0",
        linkedAt: new Date("2026-01-01"),
      },
    },
  ])(
    "rejects a revoked $type before locking config or writing Edge Config",
    async (principal) => {
      const events: string[] = []
      const store = makeStore(async () => false, events)
      const writeEdgeConfig = vi.fn(async () => ({ version: 42 }))
      const service = createConfigurationService({ store, writeEdgeConfig })
      const targetConfig = {
        version: 2 as const,
        settings: { ...DEFAULT_MONITOR_SETTINGS },
        groups: [],
        monitors: [],
      }
      const plan = await service.plan({
        baseConfigHash: currentHash,
        targetConfig,
      })

      await expect(
        service.apply({
          principal,
          principalKey: `${principal.type}:${principal.id}`,
          requestId: "req-1",
          idempotencyKey: "key-1",
          ifMatch: `"${currentHash}"`,
          request: { ...plan, targetConfig, allowDestructiveChanges: false },
        })
      ).rejects.toMatchObject({ code: "AUTHORIZATION_REVOKED" })
      expect(events).toEqual(["live authority:config:write"])
      expect(writeEdgeConfig).not.toHaveBeenCalled()
    }
  )
})

describe("default database store operation projection", () => {
  const operationRow = {
    id: "operation-1",
    baseConfigHash: "base-hash",
    targetConfigHash: "target-hash",
    planHash: "plan-hash",
    state: "written" as const,
    edgeConfigVersion: 7,
    rejectionReason: null,
    createdAt: new Date("2026-07-18T00:00:00.000Z"),
    writtenAt: new Date("2026-07-18T00:00:01.000Z"),
    acceptedAt: null,
    failedAt: null,
    // A full database row includes fields the service does not return.
    principalKey: "human:admin",
    requestId: "req-1",
    idempotencyKey: "key-1",
    desiredConfig: { huge: "payload".repeat(1000) },
    diffJson: { huge: "diff".repeat(1000) },
  }
  const expectedSerialized = {
    id: "operation-1",
    baseConfigHash: "base-hash",
    targetConfigHash: "target-hash",
    planHash: "plan-hash",
    state: "written",
    edgeConfigVersion: 7,
    rejectionReason: null,
    createdAt: "2026-07-18T00:00:00.000Z",
    writtenAt: "2026-07-18T00:00:01.000Z",
    acceptedAt: null,
    failedAt: null,
  }
  const expectedColumnKeys = [
    "acceptedAt",
    "baseConfigHash",
    "createdAt",
    "edgeConfigVersion",
    "failedAt",
    "id",
    "planHash",
    "rejectionReason",
    "state",
    "targetConfigHash",
    "writtenAt",
  ]

  it("selects and returns only the columns the service serializes, for readOperation and the idempotent-replay path", async () => {
    vi.resetModules()
    const selectColumnCalls: unknown[] = []
    const selectResults: unknown[][] = []

    function chain(result: unknown[]) {
      const c: Record<string, unknown> = {}
      for (const method of ["from", "where", "orderBy", "limit"]) {
        c[method] = vi.fn(() => c)
      }
      // biome-ignore lint/suspicious/noThenProperty: thenable mock emulates the drizzle query builder which is itself a PromiseLike
      c.then = (
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject)
      return c
    }

    const dbImpl = {
      select: vi.fn((columns: unknown) => {
        selectColumnCalls.push(columns)
        return chain(selectResults.shift() ?? [])
      }),
      transaction: vi.fn(async (work: (tx: unknown) => unknown) =>
        work(dbImpl)
      ),
      execute: vi.fn(async () => undefined),
    }

    vi.doMock("server-only", () => ({}))
    vi.doMock("@/lib/db/client", () => ({ db: dbImpl }))
    vi.doMock("./live-authority", () => ({
      hasLiveScope: vi.fn(async () => true),
    }))
    const { createConfigurationService: createServiceWithRealStore } =
      await import("./config-service")

    selectResults.push([operationRow])
    const service = createServiceWithRealStore()
    const viaReadOperation = await service.operation("operation-1")

    expect(viaReadOperation).toEqual(expectedSerialized)
    expect(Object.keys(selectColumnCalls[0] as object).sort()).toEqual(
      expectedColumnKeys
    )

    selectResults.push([operationRow])
    const replayed = await service.apply({
      principal: humanPrincipal,
      principalKey: "human:admin",
      requestId: "req-1",
      idempotencyKey: "key-1",
      ifMatch: null,
      request: {
        baseConfigHash: "base-hash",
        targetConfigHash: "target-hash",
        planHash: "plan-hash",
        targetConfig: { version: 2, settings: {}, groups: [], monitors: [] },
        allowDestructiveChanges: false,
      },
    })

    expect(replayed).toEqual(expectedSerialized)
    expect(Object.keys(selectColumnCalls[1] as object).sort()).toEqual(
      expectedColumnKeys
    )

    vi.doUnmock("server-only")
    vi.doUnmock("@/lib/db/client")
    vi.doUnmock("./live-authority")
  })
})
