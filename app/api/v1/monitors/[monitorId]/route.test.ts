import { beforeEach, describe, expect, it, vi } from "vitest"

const { idempotencyRecords } = vi.hoisted(() => ({
  idempotencyRecords: new Map<string, { status: number; body: unknown }>(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: {} }))
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}))
// Mimics executeIdempotent's real completion semantics well enough to test
// the routes' error-storing behavior without touching lib/api/idempotency.ts:
// a completed key replays its stored response and never calls work() again,
// and a key only becomes "completed" if the transaction's run() resolves.
// If run() throws, nothing is recorded, which is what proves it rolled back.
vi.mock("@/lib/api/idempotency", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/idempotency")>()),
  executeIdempotent: vi.fn(
    async ({
      request,
      work,
    }: {
      request: Request
      work: (
        tx: unknown,
        context: { operationId: string }
      ) => Promise<{ status: number; body: unknown }>
    }) => {
      const key = request.headers.get("idempotency-key")!
      const existing = idempotencyRecords.get(key)
      if (existing) {
        return { ...existing, replayed: true }
      }
      const result = await work("tx", { operationId: "op-1" })
      idempotencyRecords.set(key, result)
      return { ...result, replayed: false }
    }
  ),
}))
vi.mock("@/lib/api/monitors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/monitors")>()),
  requireMonitor: vi.fn(),
  updateMonitor: vi.fn(),
  archiveMonitor: vi.fn(),
}))

import { type ApiContext, authorize } from "@/lib/api/middleware"
import {
  archiveMonitor,
  MonitorApiError,
  requireMonitor,
  updateMonitor,
} from "@/lib/api/monitors"

import { DELETE, GET, PATCH } from "./route"

const context: ApiContext = {
  principal: {
    type: "cli_session",
    id: "cli-1",
    email: "admin@example.com",
    scopes: ["monitors:write"],
    expiresAt: new Date(),
    installation: {
      id: "ins-1",
      displayName: "Mac",
      platform: "darwin",
      architecture: "arm64",
      clientVersion: "1.0.0",
      linkedAt: new Date(),
    },
  },
  principalKey: "cli_session:cli-1",
  requestId: "req_monitor",
}

const monitor = {
  id: "site-home",
  name: "Renamed",
  url: "https://example.com",
  enabled: true,
  group: null,
  groupId: null,
  method: "GET" as const,
  intervalMinutes: 1 as const,
  timeoutMs: 8000,
  expectedStatus: { minimum: 200, maximum: 399 },
  failureThreshold: 2,
  recoveryThreshold: 2,
  recipients: [],
  certExpiresAt: null,
  certIssuer: null,
  domainExpiresAt: null,
  domainRegistrar: null,
}
const params = { params: Promise.resolve({ monitorId: "site-home" }) }

function patchRequest(body: unknown, key = crypto.randomUUID()) {
  return new Request("https://pulse.test/api/v1/monitors/site-home", {
    method: "PATCH",
    headers: { "Idempotency-Key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function deleteRequest(key = crypto.randomUUID()) {
  return new Request("https://pulse.test/api/v1/monitors/site-home", {
    method: "DELETE",
    headers: { "Idempotency-Key": key },
  })
}

function getRequest() {
  return new Request("https://pulse.test/api/v1/monitors/site-home", {
    method: "GET",
  })
}

beforeEach(() => {
  idempotencyRecords.clear()
  vi.mocked(authorize).mockReset().mockResolvedValue(context)
  vi.mocked(updateMonitor).mockReset()
  vi.mocked(archiveMonitor).mockReset()
  vi.mocked(requireMonitor).mockReset()
})

describe("GET /api/v1/monitors/{monitorId}", () => {
  it("returns the monitor with its runtime state and timestamps", async () => {
    vi.mocked(requireMonitor).mockResolvedValue({
      ...monitor,
      state: "UP",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    })
    const response = await GET(getRequest(), params)
    expect(response.status).toBe(200)
    const data = (await response.json()).data
    expect(data).toMatchObject({
      id: "site-home",
      state: "UP",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    })
    expect(requireMonitor).toHaveBeenCalledWith("site-home")
  })

  it("returns 404 for an unknown monitor", async () => {
    vi.mocked(requireMonitor).mockRejectedValue(
      new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found")
    )
    const response = await GET(getRequest(), params)
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe("MONITOR_NOT_FOUND")
  })
})

describe("PATCH /api/v1/monitors/{monitorId}", () => {
  it("updates a monitor", async () => {
    vi.mocked(updateMonitor).mockResolvedValue(monitor)
    const response = await PATCH(patchRequest({ name: "Renamed" }), params)
    expect(response.status).toBe(200)
    expect((await response.json()).data.name).toBe("Renamed")
  })

  it("forwards an explicit null groupId to clear the group, then reassigns it", async () => {
    vi.mocked(updateMonitor).mockImplementation(async (_id, body) => {
      const groupId = (body as { groupId?: string | null }).groupId ?? null
      return { ...monitor, groupId, group: groupId ? "Production" : null }
    })
    const cleared = await PATCH(patchRequest({ groupId: null }), params)
    expect(cleared.status).toBe(200)
    expect((await cleared.json()).data.groupId).toBeNull()
    // The route forwards the null body unchanged into updateMonitor, which is what
    // distinguishes clear from an absent field that leaves the group untouched.
    expect(updateMonitor).toHaveBeenCalledWith(
      "site-home",
      { groupId: null },
      context.principalKey,
      "tx"
    )

    const reassigned = await PATCH(
      patchRequest({ groupId: "production" }),
      params
    )
    expect(reassigned.status).toBe(200)
    expect((await reassigned.json()).data.groupId).toBe("production")
  })

  it("stores a deterministic MONITOR_NOT_FOUND error as the operation's own completed response", async () => {
    vi.mocked(updateMonitor).mockRejectedValue(
      new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found")
    )
    const key = crypto.randomUUID()
    const response = await PATCH(patchRequest({ name: "Renamed" }, key), params)
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe("MONITOR_NOT_FOUND")
    expect(idempotencyRecords.get(key)?.status).toBe(404)
  })

  it("lets a transient CONFIGURATION_UNAVAILABLE error propagate, leaving no completed record", async () => {
    vi.mocked(updateMonitor).mockRejectedValue(
      new MonitorApiError(
        "CONFIGURATION_UNAVAILABLE",
        "Configuration store is unavailable"
      )
    )
    const key = crypto.randomUUID()
    const response = await PATCH(patchRequest({ name: "Renamed" }, key), params)
    expect(response.status).toBe(503)
    expect(idempotencyRecords.has(key)).toBe(false)
  })

  it("replays a stored MONITOR_NOT_FOUND response on retry without re-invoking updateMonitor", async () => {
    vi.mocked(updateMonitor).mockRejectedValue(
      new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found")
    )
    const key = crypto.randomUUID()
    const first = await PATCH(patchRequest({ name: "Renamed" }, key), params)
    expect(first.status).toBe(404)
    expect(updateMonitor).toHaveBeenCalledTimes(1)

    const second = await PATCH(patchRequest({ name: "Renamed" }, key), params)
    expect(second.status).toBe(404)
    expect((await second.json()).error.code).toBe("MONITOR_NOT_FOUND")
    expect(updateMonitor).toHaveBeenCalledTimes(1)
  })
})

describe("DELETE /api/v1/monitors/{monitorId}", () => {
  it("archives a monitor", async () => {
    vi.mocked(archiveMonitor).mockResolvedValue({
      id: "site-home",
      archived: true,
    })
    const response = await DELETE(deleteRequest(), params)
    expect(response.status).toBe(200)
    expect((await response.json()).data.archived).toBe(true)
  })

  it("stores a deterministic MONITOR_NOT_FOUND error as the operation's own completed response", async () => {
    vi.mocked(archiveMonitor).mockRejectedValue(
      new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found")
    )
    const key = crypto.randomUUID()
    const response = await DELETE(deleteRequest(key), params)
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe("MONITOR_NOT_FOUND")
    expect(idempotencyRecords.get(key)?.status).toBe(404)
  })

  it("lets a transient CONFIGURATION_UNAVAILABLE error propagate, leaving no completed record", async () => {
    vi.mocked(archiveMonitor).mockRejectedValue(
      new MonitorApiError(
        "CONFIGURATION_UNAVAILABLE",
        "Configuration store is unavailable"
      )
    )
    const key = crypto.randomUUID()
    const response = await DELETE(deleteRequest(key), params)
    expect(response.status).toBe(503)
    expect(idempotencyRecords.has(key)).toBe(false)
  })

  it("replays a stored MONITOR_NOT_FOUND response on retry without re-invoking archiveMonitor", async () => {
    vi.mocked(archiveMonitor).mockRejectedValue(
      new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found")
    )
    const key = crypto.randomUUID()
    const first = await DELETE(deleteRequest(key), params)
    expect(first.status).toBe(404)
    expect(archiveMonitor).toHaveBeenCalledTimes(1)

    const second = await DELETE(deleteRequest(key), params)
    expect(second.status).toBe(404)
    expect((await second.json()).error.code).toBe("MONITOR_NOT_FOUND")
    expect(archiveMonitor).toHaveBeenCalledTimes(1)
  })
})
