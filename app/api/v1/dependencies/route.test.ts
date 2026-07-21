import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: {} }))
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}))
// Mirrors executeIdempotent's real completion semantics closely enough to
// prove the route's behavior: work() runs inside transaction(), and a key
// only records its outcome if run() resolves. A thrown run() records nothing,
// which is what proves the mutation rolled back.
const idempotencyRecords = new Map<string, { status: number; body: unknown }>()
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
vi.mock("@/lib/dependencies/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dependencies/service")>()),
  addDependency: vi.fn(),
  listDependencies: vi.fn(),
}))

import { apiError } from "@/lib/api/envelopes"
import { executeIdempotent } from "@/lib/api/idempotency"
import { type ApiContext, authorize } from "@/lib/api/middleware"
import {
  addDependency,
  DependencyApiError,
  DependencyInstallConflictError,
  listDependencies,
} from "@/lib/dependencies/service"

import { GET, POST } from "./route"

const context: ApiContext = {
  principal: {
    type: "api_token",
    id: "tok-1",
    name: "agent",
    scopes: ["dependencies:read", "dependencies:write"],
    expiresAt: new Date(),
  },
  principalKey: "api_token:tok-1",
  requestId: "req_deps",
}

const dependency = {
  id: "dep-1",
  presetId: "vercel_runtime",
  name: "Vercel Runtime",
  provider: "Vercel",
  state: "UNKNOWN",
}

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context)
  vi.mocked(listDependencies)
    .mockReset()
    .mockResolvedValue([dependency] as never)
  vi.mocked(addDependency)
    .mockReset()
    .mockResolvedValue(dependency as never)
  vi.mocked(executeIdempotent).mockClear()
  idempotencyRecords.clear()
})

describe("GET /api/v1/dependencies", () => {
  it("requires the dependencies:read scope and returns the list envelope", async () => {
    const response = await GET(
      new Request("https://pulse.test/api/v1/dependencies")
    )
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), {
      scope: "dependencies:read",
    })
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.kind).toBe("DependencyList")
    expect(payload.data).toEqual([dependency])
    expect(payload.meta).toEqual({ requestId: "req_deps", nextCursor: null })
  })

  it("returns the authorization failure untouched", async () => {
    vi.mocked(authorize).mockResolvedValue(
      apiError("req_denied", 403, "SCOPE_DENIED", "denied")
    )
    const response = await GET(
      new Request("https://pulse.test/api/v1/dependencies")
    )
    expect(response.status).toBe(403)
    expect(listDependencies).not.toHaveBeenCalled()
  })
})

describe("POST /api/v1/dependencies", () => {
  function postRequest(body: unknown) {
    return new Request("https://pulse.test/api/v1/dependencies", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    })
  }

  it("requires the dependencies:write scope and returns 201 with the Dependency envelope", async () => {
    const response = await POST(postRequest({ presetId: "vercel_runtime" }))
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), {
      scope: "dependencies:write",
    })
    expect(response.status).toBe(201)
    const payload = await response.json()
    expect(payload.kind).toBe("Dependency")
    expect(payload.data).toEqual(dependency)
  })

  it("never accepts a URL or upstream component id, only presetId/scopeId/notificationsEnabled", async () => {
    const response = await POST(
      postRequest({
        presetId: "vercel_runtime",
        url: "https://vercel.com",
        componentId: "abc",
      })
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("INVALID_REQUEST")
    expect(addDependency).not.toHaveBeenCalled()
  })

  it("rejects a missing presetId", async () => {
    const response = await POST(postRequest({}))
    expect(response.status).toBe(400)
    expect(addDependency).not.toHaveBeenCalled()
  })

  it("installs inside the idempotency transaction, pinning the id and passing the tx handle", async () => {
    await POST(postRequest({ presetId: "vercel_runtime" }))
    expect(addDependency).toHaveBeenCalledWith(
      { presetId: "vercel_runtime" },
      { dependencyId: "op-1" },
      "tx"
    )
  })

  it("replays the stored response for a repeated idempotency key without reinstalling", async () => {
    const request = postRequest({ presetId: "vercel_runtime" })
    const first = await POST(request.clone())
    expect(first.status).toBe(201)
    expect(addDependency).toHaveBeenCalledTimes(1)
    const replay = await POST(request)
    expect(replay.status).toBe(201)
    expect(addDependency).toHaveBeenCalledTimes(1)
  })

  it("stores a duplicate as a clean 409 rather than rolling the transaction back", async () => {
    vi.mocked(addDependency).mockRejectedValue(
      new DependencyApiError("DEPENDENCY_EXISTS", "Already installed")
    )
    const request = postRequest({ presetId: "vercel_runtime" })
    const response = await POST(request.clone())
    expect(response.status).toBe(409)
    // The 409 was recorded, so a retry with the same key replays it.
    const replay = await POST(request)
    expect(replay.status).toBe(409)
    expect(addDependency).toHaveBeenCalledTimes(1)
  })

  it("returns 409 without storing when the install races another request inside the transaction", async () => {
    vi.mocked(addDependency).mockRejectedValue(
      new DependencyInstallConflictError(
        "An active dependency already exists for this preset and scope"
      )
    )
    const request = postRequest({ presetId: "vercel_runtime" })
    const response = await POST(request.clone())
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe("DEPENDENCY_EXISTS")
    // Nothing committed, since Postgres already aborted the transaction the
    // race hit, so a retry with the same key redoes the work rather than
    // replaying a stored response.
    const retry = await POST(request)
    expect(retry.status).toBe(409)
    expect(addDependency).toHaveBeenCalledTimes(2)
  })

  it("maps PRESET_NOT_FOUND to 400", async () => {
    vi.mocked(addDependency).mockRejectedValue(
      new DependencyApiError("PRESET_NOT_FOUND", "Preset was not found")
    )
    const response = await POST(postRequest({ presetId: "nope" }))
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("PRESET_NOT_FOUND")
  })

  it("maps DEPENDENCY_EXISTS to 409", async () => {
    vi.mocked(addDependency).mockRejectedValue(
      new DependencyApiError("DEPENDENCY_EXISTS", "Already installed")
    )
    const response = await POST(postRequest({ presetId: "vercel_runtime" }))
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe("DEPENDENCY_EXISTS")
  })

  it("maps SCOPE_REQUIRED to 400", async () => {
    vi.mocked(addDependency).mockRejectedValue(
      new DependencyApiError("SCOPE_REQUIRED", "scopeId required")
    )
    const response = await POST(postRequest({ presetId: "neon_database" }))
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("SCOPE_REQUIRED")
  })

  it("rejects invalid JSON bodies", async () => {
    const response = await POST(
      new Request("https://pulse.test/api/v1/dependencies", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: "{not json",
      })
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("INVALID_JSON")
  })
})
