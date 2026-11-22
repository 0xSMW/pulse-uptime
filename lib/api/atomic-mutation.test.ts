import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: {} }))
vi.mock("@/lib/api/idempotency", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/idempotency")>()),
  executeIdempotent: vi.fn(),
}))
vi.mock("@/lib/api/live-authority", () => ({ hasLiveScope: vi.fn() }))

import { apiError, errorEnvelope } from "@/lib/api/envelopes"
import { executeIdempotent, type StoredResponse } from "@/lib/api/idempotency"
import { hasLiveScope } from "@/lib/api/live-authority"
import type { DatabaseHandle } from "@/lib/db/client"

import { runAtomicMutation } from "./atomic-mutation"

const stubTx = "stub-tx" as unknown as DatabaseHandle
const context = {
  principalKey: "api_token:tok-1",
  requestId: "req-1",
  principal: {
    type: "api_token" as const,
    id: "tok-1",
    name: "test",
    scopes: ["monitors:write" as const],
    expiresAt: new Date("2099-01-01T00:00:00Z"),
  },
}
const body = { name: "Production" }

function request() {
  return new Request("https://pulse.test/api/v1/groups/production", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": "00000000-0000-4000-8000-000000000001",
    },
    body: JSON.stringify(body),
  })
}

function input(
  work: Parameters<typeof runAtomicMutation>[0]["work"] = vi.fn(async () => ({
    status: 200,
    kind: "Group",
    data: { id: "production", name: "Production" },
  }))
) {
  return {
    request: request(),
    context,
    scope: "monitors:write" as const,
    routeKey: "/api/v1/groups/production",
    body,
    work,
    storedError: vi.fn<
      (error: unknown, requestId: string) => StoredResponse | null
    >(() => null),
    mapError: vi.fn<(error: unknown, requestId: string) => Response | null>(
      () => null
    ),
  }
}

beforeEach(() => {
  vi.mocked(executeIdempotent).mockReset()
  vi.mocked(hasLiveScope).mockReset()
  vi.mocked(hasLiveScope).mockResolvedValue(true)
})

describe("runAtomicMutation", () => {
  it("stores a denial before work when authority changed after route authorization", async () => {
    vi.mocked(hasLiveScope).mockResolvedValue(false)
    vi.mocked(executeIdempotent).mockImplementation(async (options) => {
      const result = await (
        options.work as (
          tx: DatabaseHandle,
          operation: { operationId: string }
        ) => Promise<{ status: number; body: unknown }>
      )(stubTx, { operationId: "op-1" })
      return { ...result, replayed: false }
    })
    const mutation = input()

    const response = await runAtomicMutation(mutation)

    expect(hasLiveScope).toHaveBeenCalledWith(
      stubTx,
      context.principal,
      "monitors:write"
    )
    expect(mutation.work).not.toHaveBeenCalled()
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("SCOPE_DENIED")
  })

  it("preserves the idempotency route, body hash input, atomic mode, and transaction handle", async () => {
    vi.mocked(executeIdempotent).mockImplementation(async (options) => {
      expect(options).toMatchObject({
        principalKey: context.principalKey,
        routeKey: "/api/v1/groups/production",
        body,
        mode: "atomic",
      })
      const result = await (
        options.work as (
          tx: DatabaseHandle,
          operation: { operationId: string }
        ) => Promise<{ status: number; body: unknown }>
      )(stubTx, { operationId: "op-1" })
      return { ...result, replayed: false }
    })
    const work = vi.fn(async () => ({
      status: 201,
      kind: "Group",
      data: { id: "production" },
    }))

    const response = await runAtomicMutation(input(work))

    expect(work).toHaveBeenCalledWith(stubTx, { operationId: "op-1" })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      apiVersion: "v1",
      kind: "Group",
      data: { id: "production" },
      meta: { requestId: "req-1" },
    })
  })

  it("stores a recognized deterministic error inside the atomic work call", async () => {
    const completions: Array<{ status: number; body: unknown }> = []
    vi.mocked(executeIdempotent).mockImplementation(async (options) => {
      const result = await (
        options.work as (
          tx: DatabaseHandle,
          operation: { operationId: string }
        ) => Promise<{ status: number; body: unknown }>
      )(stubTx, { operationId: "op-1" })
      completions.push(result)
      return { ...result, replayed: false }
    })
    const domainError = new Error("Group was not found")
    const mutation = input(async () => {
      throw domainError
    })
    mutation.storedError.mockImplementation((error) =>
      error === domainError
        ? {
            status: 404,
            body: errorEnvelope(
              "GROUP_NOT_FOUND",
              "Group was not found",
              context.requestId
            ),
          }
        : null
    )

    const response = await runAtomicMutation(mutation)

    expect(response.status).toBe(404)
    expect((await response.json()).error).toMatchObject({
      code: "GROUP_NOT_FOUND",
      message: "Group was not found",
      requestId: "req-1",
    })
    expect(completions).toHaveLength(1)
  })

  it("lets transient errors reject atomic work and maps them after rollback", async () => {
    let completed = false
    vi.mocked(executeIdempotent).mockImplementation(async (options) => {
      const result = await (
        options.work as (
          tx: DatabaseHandle,
          operation: { operationId: string }
        ) => Promise<{ status: number; body: unknown }>
      )(stubTx, { operationId: "op-1" })
      completed = true
      return { ...result, replayed: false }
    })
    const transient = new Error("Configuration store is unavailable")
    const mutation = input(async () => {
      throw transient
    })
    mutation.mapError.mockImplementation((error, requestId) =>
      error === transient
        ? apiError(
            requestId,
            503,
            "CONFIGURATION_UNAVAILABLE",
            transient.message
          )
        : null
    )

    const response = await runAtomicMutation(mutation)

    expect(response.status).toBe(503)
    expect(completed).toBe(false)
    expect(mutation.storedError).toHaveBeenCalledWith(transient, "req-1")
    expect(mutation.mapError).toHaveBeenCalledWith(transient, "req-1")
  })

  it("replays the stored status and body with the same API headers without running work", async () => {
    const storedBody = errorEnvelope(
      "GROUP_NOT_EMPTY",
      "Move or ungroup monitors before deleting this group",
      "req-original",
      { monitorCount: 2 }
    )
    vi.mocked(executeIdempotent).mockResolvedValue({
      status: 409,
      body: storedBody,
      replayed: true,
    })
    const options = input()

    const response = await runAtomicMutation(options)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(storedBody)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("x-pulse-api-version")).toBe("v1")
    expect(options.work).not.toHaveBeenCalled()
  })
})
