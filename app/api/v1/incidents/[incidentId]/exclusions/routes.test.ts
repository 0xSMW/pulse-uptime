import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/api/principal", () => ({ authenticatePrincipal: vi.fn() }))
vi.mock("@/lib/api/rate-limit", () => ({
  AUTHENTICATED_READ_LIMIT: {},
  AUTHENTICATED_MUTATION_LIMIT: {},
  enforceRateLimit: vi.fn(async () => ({ allowed: true })),
}))
vi.mock("@/lib/incidents/exclusions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/incidents/exclusions")>()
  return {
    ...actual,
    previewIncidentExclusion: vi.fn(),
    applyIncidentExclusion: vi.fn(),
    undoIncidentExclusion: vi.fn(),
  }
})
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/api/idempotency", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/idempotency")>()
  return { ...actual, executeIdempotent: vi.fn() }
})

import { executeIdempotent } from "@/lib/api/idempotency"
import { authenticatePrincipal } from "@/lib/api/principal"
import {
  applyIncidentExclusion,
  IncidentExclusionError,
  previewIncidentExclusion,
  undoIncidentExclusion,
} from "@/lib/incidents/exclusions"
import { POST as undo } from "./[exclusionId]/undo/route"
import { POST as preview } from "./preview/route"
import { POST as apply } from "./route"

const incidentId = crypto.randomUUID()
const exclusionId = crypto.randomUUID()
const params = Promise.resolve({ incidentId, exclusionId })
const body = {
  startAt: "2026-11-13T19:00:00.000Z",
  endAt: "2026-11-14T06:16:00.000Z",
  reason: "false alarm",
  previewVersion: "a".repeat(64),
}
function request(document: unknown = {}, origin = "https://pulse.example") {
  return new Request(
    `https://pulse.example/api/v1/incidents/${incidentId}/exclusions`,
    {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(document),
    }
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://pulse.example")
  vi.mocked(authenticatePrincipal).mockResolvedValue({
    type: "human",
    id: "admin",
    sessionId: "session",
    email: "admin@example.com",
    role: "admin",
    scopes: ["monitors:write"],
  })
})
describe("exclusion route authorization and request contracts", () => {
  it("denies viewers on preview, apply, and undo", async () => {
    vi.mocked(authenticatePrincipal).mockResolvedValue({
      type: "human",
      id: "viewer",
      sessionId: "session",
      email: "viewer@example.com",
      role: "viewer",
      scopes: ["incidents:read"],
    })
    for (const handler of [preview, apply, undo]) {
      const response = await handler(request(body), { params })
      expect(response.status).toBe(403)
      expect((await response.json()).error.code).toBe("SCOPE_DENIED")
    }
    expect(previewIncidentExclusion).not.toHaveBeenCalled()
    expect(applyIncidentExclusion).not.toHaveBeenCalled()
    expect(undoIncidentExclusion).not.toHaveBeenCalled()
  })
  it("rejects cross-origin human requests before any service work", async () => {
    const response = await preview(request({}, "https://attacker.example"), {
      params,
    })
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("INVALID_ORIGIN")
    expect(previewIncidentExclusion).not.toHaveBeenCalled()
  })
  it("denies unauthenticated requests", async () => {
    vi.mocked(authenticatePrincipal).mockResolvedValue(null)
    expect((await apply(request(body), { params })).status).toBe(401)
  })
  it("rejects invalid timestamps and extra request fields", async () => {
    expect(
      (await preview(request({ startAt: "not a date" }), { params })).status
    ).toBe(400)
    expect(
      (await apply(request({ ...body, monitorId: "other" }), { params })).status
    ).toBe(400)
    expect(executeIdempotent).not.toHaveBeenCalled()
  })
  it("returns preview errors with stable domain codes", async () => {
    vi.mocked(previewIncidentExclusion).mockRejectedValue(
      new IncidentExclusionError(
        "EXCLUSION_EVIDENCE_UNAVAILABLE",
        "Evidence unavailable"
      )
    )
    const response = await preview(request(), { params })
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe(
      "EXCLUSION_EVIDENCE_UNAVAILABLE"
    )
  })
  it("requires atomic work and fingerprints the preview precondition", async () => {
    vi.mocked(executeIdempotent).mockResolvedValue({
      status: 201,
      body: { data: {} },
      replayed: true,
    })
    expect((await apply(request(body), { params })).status).toBe(201)
    expect(executeIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "atomic",
        principalKey: "human:admin",
        body,
      })
    )
  })
})
