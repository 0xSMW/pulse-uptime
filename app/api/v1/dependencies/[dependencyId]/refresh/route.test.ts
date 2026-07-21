import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: {} }))
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/api/idempotency", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/idempotency")>()),
  executeIdempotent: vi.fn(
    async ({
      work,
    }: {
      work: (
        tx: unknown,
        context: { operationId: string }
      ) => Promise<{ status: number; body: unknown }>
    }) => ({
      ...(await work("tx", { operationId: "op-1" })),
      replayed: false,
    })
  ),
}))
vi.mock("@/lib/dependencies/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dependencies/service")>()),
  scheduleDependencyPoll: vi.fn(),
}))

import { type ApiContext, authorize } from "@/lib/api/middleware"
import {
  DependencyApiError,
  scheduleDependencyPoll,
} from "@/lib/dependencies/service"

import { POST } from "./route"

const context: ApiContext = {
  principal: {
    type: "api_token",
    id: "tok-1",
    name: "agent",
    scopes: ["dependencies:write"],
    expiresAt: new Date(),
  },
  principalKey: "api_token:tok-1",
  requestId: "req_refresh",
}

const params = { params: Promise.resolve({ dependencyId: "dep-1" }) }

function refreshRequest() {
  return new Request("https://pulse.test/api/v1/dependencies/dep-1/refresh", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
  })
}

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context)
  vi.mocked(scheduleDependencyPoll)
    .mockReset()
    .mockResolvedValue({ id: "dep-1", queued: true })
})

describe("POST /api/v1/dependencies/{dependencyId}/refresh", () => {
  it("requires the dependencies:write scope and returns 202 with a queued ack, never fetching inline", async () => {
    const response = await POST(refreshRequest(), params)
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), {
      scope: "dependencies:write",
    })
    expect(response.status).toBe(202)
    const payload = await response.json()
    expect(payload.kind).toBe("DependencyRefresh")
    expect(payload.data).toEqual({ id: "dep-1", queued: true })
    expect(scheduleDependencyPoll).toHaveBeenCalledWith("dep-1", {}, "tx")
  })

  it("maps DEPENDENCY_NOT_FOUND to 404", async () => {
    vi.mocked(scheduleDependencyPoll).mockRejectedValue(
      new DependencyApiError("DEPENDENCY_NOT_FOUND", "Dependency was not found")
    )
    const response = await POST(refreshRequest(), params)
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe("DEPENDENCY_NOT_FOUND")
  })
})
