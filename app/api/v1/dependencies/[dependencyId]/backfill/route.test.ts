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
  retryDependencyBackfill: vi.fn(),
}))

import { type ApiContext, authorize } from "@/lib/api/middleware"
import {
  DependencyApiError,
  retryDependencyBackfill,
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
  requestId: "req_backfill",
}

const params = { params: Promise.resolve({ dependencyId: "dep-1" }) }

const dependency = {
  id: "dep-1",
  presetId: "vercel_runtime",
  backfillFailedAt: null,
  state: "OPERATIONAL",
}

function backfillRequest() {
  return new Request("https://pulse.test/api/v1/dependencies/dep-1/backfill", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
  })
}

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context)
  vi.mocked(retryDependencyBackfill)
    .mockReset()
    .mockResolvedValue(dependency as never)
})

describe("POST /api/v1/dependencies/{dependencyId}/backfill", () => {
  it("requires the dependencies:write scope and returns 200 with the refreshed dependency, mark cleared", async () => {
    const response = await POST(backfillRequest(), params)
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), {
      scope: "dependencies:write",
    })
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.kind).toBe("Dependency")
    expect(payload.data).toEqual(dependency)
    expect(payload.data.backfillFailedAt).toBeNull()
    expect(retryDependencyBackfill).toHaveBeenCalledWith("dep-1", {}, "tx")
  })

  it("maps DEPENDENCY_NOT_FOUND to 404", async () => {
    vi.mocked(retryDependencyBackfill).mockRejectedValue(
      new DependencyApiError("DEPENDENCY_NOT_FOUND", "Dependency was not found")
    )
    const response = await POST(backfillRequest(), params)
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe("DEPENDENCY_NOT_FOUND")
  })

  it("returns the authorization failure untouched", async () => {
    const denied = new Response(null, { status: 403 })
    vi.mocked(authorize).mockResolvedValue(denied as never)
    const response = await POST(backfillRequest(), params)
    expect(response.status).toBe(403)
    expect(retryDependencyBackfill).not.toHaveBeenCalled()
  })
})
