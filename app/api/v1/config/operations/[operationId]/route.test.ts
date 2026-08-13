import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: {} }))
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/api/config-service", () => ({
  configurationService: { operation: vi.fn() },
}))

import { configurationService } from "@/lib/api/config-service"
import { type ApiContext, authorize } from "@/lib/api/middleware"

import { GET } from "./route"

const OPERATION_ID = "22222222-2222-4222-8222-222222222222"
const context: ApiContext = {
  principal: {
    type: "api_token",
    id: "tok-1",
    name: "agent",
    scopes: ["config:read"],
    expiresAt: new Date(),
  },
  principalKey: "api_token:tok-1",
  requestId: "req_operation",
}

function routeParams(operationId: string) {
  return { params: Promise.resolve({ operationId }) }
}

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context)
  vi.mocked(configurationService.operation)
    .mockReset()
    .mockResolvedValue({
      id: OPERATION_ID,
      status: "succeeded",
    } as never)
})

describe("GET /api/v1/config/operations/{operationId}", () => {
  it("returns the existing operation envelope for a valid UUID", async () => {
    const response = await GET(
      new Request(
        `https://pulse.test/api/v1/config/operations/${OPERATION_ID}`
      ),
      routeParams(OPERATION_ID)
    )

    expect(response.status).toBe(200)
    expect((await response.json()).kind).toBe("ConfigurationOperation")
    expect(configurationService.operation).toHaveBeenCalledWith(OPERATION_ID)
  })

  it("rejects a malformed UUID before querying storage", async () => {
    const response = await GET(
      new Request("https://pulse.test/api/v1/config/operations/not-a-uuid"),
      routeParams("not-a-uuid")
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("INVALID_OPERATION")
    expect(configurationService.operation).not.toHaveBeenCalled()
  })
})
