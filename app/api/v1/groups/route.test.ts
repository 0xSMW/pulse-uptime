import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: {} }))
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/api/idempotency", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/idempotency")>()),
  executeIdempotent: vi.fn(),
}))
vi.mock("@/lib/api/groups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/groups")>()),
  createGroup: vi.fn(),
  listGroups: vi.fn(),
}))

import { createGroup, GroupApiError, listGroups } from "@/lib/api/groups"
import {
  executeIdempotent,
  type IdempotencyContext,
} from "@/lib/api/idempotency"
import { type ApiContext, authorize } from "@/lib/api/middleware"
import type { DatabaseHandle } from "@/lib/db/client"

import { GET, POST } from "./route"

const context: ApiContext = {
  principal: {
    type: "api_token",
    id: "tok-1",
    name: "agent",
    scopes: ["monitors:read", "monitors:write"],
    expiresAt: new Date(),
  },
  principalKey: "api_token:tok-1",
  requestId: "req_groups",
}

const stubTx = "stub-tx" as unknown as DatabaseHandle

function postRequest(body: unknown) {
  return new Request("https://pulse.test/api/v1/groups", {
    method: "POST",
    headers: { "Idempotency-Key": "00000000-0000-4000-8000-000000000001" },
    body: JSON.stringify(body),
  })
}

describe("GET /api/v1/groups", () => {
  beforeEach(() => {
    vi.mocked(authorize).mockReset().mockResolvedValue(context)
    vi.mocked(listGroups)
      .mockReset()
      .mockResolvedValue([
        { id: "production", name: "Production", monitorCount: 0 },
      ])
  })

  it("returns the group list envelope", async () => {
    const response = await GET(new Request("https://pulse.test/api/v1/groups"))
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.kind).toBe("GroupList")
    expect(payload.data).toEqual([
      { id: "production", name: "Production", monitorCount: 0 },
    ])
  })
})

/**
 * executeIdempotent is mocked here (mirroring the status-reports route test
 * family, see lib/api/status-report-http.test.ts): the fake models the one
 * contract POST's inline try/catch depends on, that context.transaction only
 * records a completion (into `completions`, standing in for the DB write)
 * when its callback resolves. A GroupApiError caught inside that callback
 * resolves it with the stored error response, so it commits like any other
 * completion; a non-domain error rejects it, so nothing is pushed, mirroring
 * a rolled-back transaction that leaves the record running.
 */
describe("POST /api/v1/groups", () => {
  let completions: Array<{ status: number; body: unknown }>

  beforeEach(() => {
    vi.mocked(authorize).mockReset().mockResolvedValue(context)
    vi.mocked(createGroup).mockReset()
    completions = []
    vi.mocked(executeIdempotent)
      .mockReset()
      .mockImplementation(async ({ work }) => {
        const idempotencyContext: IdempotencyContext = {
          operationId: "op-1",
          transaction: async (run) => {
            const result = await run(stubTx)
            completions.push({ status: result.status, body: result.body })
            return result
          },
        }
        const result = await work(idempotencyContext)
        return { ...result, replayed: false }
      })
  })

  it("creates a group and returns 201 with the group envelope", async () => {
    vi.mocked(createGroup).mockResolvedValue({
      id: "production",
      name: "Production",
      monitorCount: 0,
    })
    const response = await POST(
      postRequest({ id: "production", name: "Production" })
    )
    expect(response.status).toBe(201)
    const payload = await response.json()
    expect(payload.kind).toBe("Group")
    expect(payload.data).toEqual({
      id: "production",
      name: "Production",
      monitorCount: 0,
    })
    expect(completions).toMatchObject([{ status: 201 }])
  })

  it("stores a GROUP_EXISTS domain error as the operation's own completed 409, the same status a first attempt maps to", async () => {
    vi.mocked(createGroup).mockRejectedValue(
      new GroupApiError("GROUP_EXISTS", "A group with this name already exists")
    )
    const response = await POST(
      postRequest({ id: "production", name: "Production" })
    )
    expect(response.status).toBe(409)
    const payload = await response.json()
    expect(payload.error.code).toBe("GROUP_EXISTS")
    // Committed, not left running: addGroup validates and throws before
    // nextConfig writes anything, so the completion can commit alongside
    // this stored error, and a stale-window retry replays it instead of
    // rerunning createGroup against whatever groups exist by then.
    expect(completions).toMatchObject([{ status: 409 }])
    expect(completions[0]!.body).toMatchObject({
      kind: "Error",
      error: { code: "GROUP_EXISTS" },
    })
  })

  it("propagates a non-domain error out of the transaction without recording a completion", async () => {
    vi.mocked(createGroup).mockRejectedValue(new Error("db exploded"))
    const response = await POST(
      postRequest({ id: "production", name: "Production" })
    )
    expect(response.status).toBe(500)
    expect(completions).toEqual([])
  })

  it("replays a stored completion verbatim without re-invoking createGroup", async () => {
    const storedBody = {
      apiVersion: "v1",
      kind: "Error",
      error: {
        code: "GROUP_EXISTS",
        message: "A group with this name already exists",
        details: {},
        requestId: "req_groups",
      },
    }
    vi.mocked(executeIdempotent).mockResolvedValue({
      status: 409,
      body: storedBody,
      replayed: true,
    })
    const response = await POST(
      postRequest({ id: "production", name: "Production" })
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(storedBody)
    expect(createGroup).not.toHaveBeenCalled()
  })
})
