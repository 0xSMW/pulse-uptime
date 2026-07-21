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
  updateGroup: vi.fn(),
  deleteGroup: vi.fn(),
}))

import { deleteGroup, GroupApiError, updateGroup } from "@/lib/api/groups"
import {
  executeIdempotent,
  type IdempotencyContext,
} from "@/lib/api/idempotency"
import { type ApiContext, authorize } from "@/lib/api/middleware"
import type { DatabaseHandle } from "@/lib/db/client"

import { DELETE, PATCH } from "./route"

const context: ApiContext = {
  principal: {
    type: "api_token",
    id: "tok-1",
    name: "agent",
    scopes: ["monitors:write"],
    expiresAt: new Date(),
  },
  principalKey: "api_token:tok-1",
  requestId: "req_groups",
}

const stubTx = "stub-tx" as unknown as DatabaseHandle
const params = { params: Promise.resolve({ groupId: "production" }) }

function patchRequest(body: unknown) {
  return new Request("https://pulse.test/api/v1/groups/production", {
    method: "PATCH",
    headers: { "Idempotency-Key": "00000000-0000-4000-8000-000000000001" },
    body: JSON.stringify(body),
  })
}

function deleteRequest() {
  return new Request("https://pulse.test/api/v1/groups/production", {
    method: "DELETE",
    headers: { "Idempotency-Key": "00000000-0000-4000-8000-000000000002" },
  })
}

/**
 * executeIdempotent is mocked here (mirroring the status-reports route test
 * family, see lib/api/status-report-http.test.ts): the fake models the one
 * contract PATCH/DELETE's inline try/catch depends on, that
 * context.transaction only records a completion (into `completions`,
 * standing in for the DB write) when its callback resolves. A GroupApiError
 * caught inside that callback resolves it with the stored error response,
 * so it commits like any other completion; a non-domain error rejects it,
 * so nothing is pushed, mirroring a rolled-back transaction that leaves the
 * record running.
 */
describe("PATCH /api/v1/groups/{groupId}", () => {
  let completions: Array<{ status: number; body: unknown }>

  beforeEach(() => {
    vi.mocked(authorize).mockReset().mockResolvedValue(context)
    vi.mocked(updateGroup).mockReset()
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

  it("renames a group and returns 200 with the group envelope", async () => {
    vi.mocked(updateGroup).mockResolvedValue({
      id: "production",
      name: "Core",
      monitorCount: 0,
    })
    const response = await PATCH(patchRequest({ name: "Core" }), params)
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.kind).toBe("Group")
    expect(payload.data).toEqual({
      id: "production",
      name: "Core",
      monitorCount: 0,
    })
    expect(completions).toMatchObject([{ status: 200 }])
  })

  it("stores a GROUP_NOT_FOUND domain error as the operation's own completed 404, the same status a first attempt maps to", async () => {
    vi.mocked(updateGroup).mockRejectedValue(
      new GroupApiError("GROUP_NOT_FOUND", "Group was not found")
    )
    const response = await PATCH(patchRequest({ name: "Core" }), params)
    expect(response.status).toBe(404)
    const payload = await response.json()
    expect(payload.error.code).toBe("GROUP_NOT_FOUND")
    // Committed, not left running: renameGroup validates and throws before
    // nextConfig writes anything, so the completion can commit alongside
    // this stored error, and a stale-window retry replays it instead of
    // rerunning updateGroup against whatever groups exist by then.
    expect(completions).toMatchObject([{ status: 404 }])
    expect(completions[0]!.body).toMatchObject({
      kind: "Error",
      error: { code: "GROUP_NOT_FOUND" },
    })
  })

  it("stores a GROUP_EXISTS domain error as the operation's own completed 409", async () => {
    vi.mocked(updateGroup).mockRejectedValue(
      new GroupApiError("GROUP_EXISTS", "A group with this name already exists")
    )
    const response = await PATCH(patchRequest({ name: "Core" }), params)
    expect(response.status).toBe(409)
    expect(completions).toMatchObject([{ status: 409 }])
  })

  it("propagates a non-domain error out of the transaction without recording a completion", async () => {
    vi.mocked(updateGroup).mockRejectedValue(new Error("db exploded"))
    const response = await PATCH(patchRequest({ name: "Core" }), params)
    expect(response.status).toBe(500)
    expect(completions).toEqual([])
  })

  it("replays a stored completion verbatim without re-invoking updateGroup", async () => {
    const storedBody = {
      apiVersion: "v1",
      kind: "Error",
      error: {
        code: "GROUP_NOT_FOUND",
        message: "Group was not found",
        details: {},
        requestId: "req_groups",
      },
    }
    vi.mocked(executeIdempotent).mockResolvedValue({
      status: 404,
      body: storedBody,
      replayed: true,
    })
    const response = await PATCH(patchRequest({ name: "Core" }), params)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual(storedBody)
    expect(updateGroup).not.toHaveBeenCalled()
  })
})

describe("DELETE /api/v1/groups/{groupId}", () => {
  let completions: Array<{ status: number; body: unknown }>

  beforeEach(() => {
    vi.mocked(authorize).mockReset().mockResolvedValue(context)
    vi.mocked(deleteGroup).mockReset()
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

  it("deletes a group and returns 200 with the deletion envelope", async () => {
    vi.mocked(deleteGroup).mockResolvedValue({
      id: "production",
      deleted: true,
    })
    const response = await DELETE(deleteRequest(), params)
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.kind).toBe("GroupDeletion")
    expect(payload.data).toEqual({ id: "production", deleted: true })
    expect(completions).toMatchObject([{ status: 200 }])
  })

  it("stores a GROUP_NOT_EMPTY domain error as the operation's own completed 409, the same status a first attempt maps to", async () => {
    vi.mocked(deleteGroup).mockRejectedValue(
      new GroupApiError(
        "GROUP_NOT_EMPTY",
        "Move or ungroup monitors before deleting this group",
        { monitorCount: 2 }
      )
    )
    const response = await DELETE(deleteRequest(), params)
    expect(response.status).toBe(409)
    const payload = await response.json()
    expect(payload.error.code).toBe("GROUP_NOT_EMPTY")
    expect(payload.error.details).toEqual({ monitorCount: 2 })
    // Committed, not left running: removeGroup validates and throws before
    // nextConfig writes anything, so the completion can commit alongside
    // this stored error, and a stale-window retry replays it instead of
    // rerunning deleteGroup against whatever monitors exist by then.
    expect(completions).toMatchObject([{ status: 409 }])
    expect(completions[0]!.body).toMatchObject({
      kind: "Error",
      error: { code: "GROUP_NOT_EMPTY" },
    })
  })

  it("stores a GROUP_NOT_FOUND domain error as the operation's own completed 404", async () => {
    vi.mocked(deleteGroup).mockRejectedValue(
      new GroupApiError("GROUP_NOT_FOUND", "Group was not found")
    )
    const response = await DELETE(deleteRequest(), params)
    expect(response.status).toBe(404)
    expect(completions).toMatchObject([{ status: 404 }])
  })

  it("propagates a non-domain error out of the transaction without recording a completion", async () => {
    vi.mocked(deleteGroup).mockRejectedValue(new Error("db exploded"))
    const response = await DELETE(deleteRequest(), params)
    expect(response.status).toBe(500)
    expect(completions).toEqual([])
  })

  it("replays a stored completion verbatim without re-invoking deleteGroup", async () => {
    const storedBody = {
      apiVersion: "v1",
      kind: "Error",
      error: {
        code: "GROUP_NOT_EMPTY",
        message: "Move or ungroup monitors before deleting this group",
        details: { monitorCount: 2 },
        requestId: "req_groups",
      },
    }
    vi.mocked(executeIdempotent).mockResolvedValue({
      status: 409,
      body: storedBody,
      replayed: true,
    })
    const response = await DELETE(deleteRequest(), params)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(storedBody)
    expect(deleteGroup).not.toHaveBeenCalled()
  })
})
