import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: {} }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
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
vi.mock("@/lib/api/status-reports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/status-reports")>()),
  editReportUpdate: vi.fn(),
  deleteReportUpdate: vi.fn(),
}))

import { revalidatePath } from "next/cache"

import { executeIdempotent } from "@/lib/api/idempotency"
import { type ApiContext, authorize } from "@/lib/api/middleware"
import {
  deleteReportUpdate,
  editReportUpdate,
  type StatusReportData,
  StatusReportError,
} from "@/lib/api/status-reports"

import { DELETE, PATCH } from "./route"

const context: ApiContext = {
  principal: {
    type: "human",
    role: "admin",
    id: "usr-1",
    email: "admin@example.com",
    scopes: ["reports:write"],
  },
  principalKey: "human:usr-1",
  requestId: "req_edit",
}

const report: StatusReportData = {
  id: "rep-1",
  type: "incident",
  title: "API outage",
  startsAt: "2026-07-18T09:00:00.000Z",
  endsAt: null,
  publishedAt: "2026-07-18T09:05:00.000Z",
  resolvedAt: null,
  originIncidentId: null,
  currentStatus: "monitoring",
  updates: [
    {
      id: "upd-1",
      status: "monitoring",
      markdown: "Watching.",
      publishedAt: "2026-07-18T10:00:00.000Z",
      createdAt: "2026-07-18T10:00:00.000Z",
    },
  ],
  updatesCount: 1,
  updatesNextCursor: null,
  affected: [],
  createdAt: "2026-07-18T09:05:00.000Z",
  updatedAt: "2026-07-18T10:00:00.000Z",
}

const params = {
  params: Promise.resolve({ reportId: "rep-1", updateId: "upd-1" }),
}

function request(method: string, body?: unknown) {
  return new Request(
    "https://pulse.test/api/v1/status-reports/rep-1/updates/upd-1",
    {
      method,
      headers: { "Idempotency-Key": crypto.randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }
  )
}

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context)
  vi.mocked(revalidatePath).mockReset()
  vi.mocked(editReportUpdate).mockReset().mockResolvedValue(report)
  vi.mocked(deleteReportUpdate).mockReset().mockResolvedValue(report)
  vi.mocked(executeIdempotent).mockClear()
})

describe("PATCH /api/v1/status-reports/{reportId}/updates/{updateId}", () => {
  it("requires reports:write, sends only changed keys through, and revalidates", async () => {
    const response = await PATCH(
      request("PATCH", { publishedAt: "2026-07-18T08:00:00.000Z" }),
      params
    )
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), {
      scope: "reports:write",
    })
    expect(response.status).toBe(200)
    expect(editReportUpdate).toHaveBeenCalledWith(
      "rep-1",
      "upd-1",
      { publishedAt: "2026-07-18T08:00:00.000Z" },
      expect.anything()
    )
    expect((await response.json()).kind).toBe("StatusReport")
    expect(revalidatePath).toHaveBeenCalledWith("/status")
  })

  it("maps a missing update to 404 UPDATE_NOT_FOUND", async () => {
    vi.mocked(editReportUpdate).mockRejectedValue(
      new StatusReportError("UPDATE_NOT_FOUND", "missing")
    )
    const response = await PATCH(
      request("PATCH", { status: "monitoring" }),
      params
    )
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe("UPDATE_NOT_FOUND")
  })

  it("maps UPDATE_NOT_FOUND inside work() itself, not thrown past executeIdempotent (finding: a thrown error left the idempotency record stuck 'running' until a stale reclaim, which now simply reruns work() from scratch rather than trying to recover)", async () => {
    vi.mocked(editReportUpdate).mockRejectedValue(
      new StatusReportError("UPDATE_NOT_FOUND", "missing")
    )
    const response = await PATCH(
      request("PATCH", { status: "monitoring" }),
      params
    )
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe("UPDATE_NOT_FOUND")
  })
})

describe("DELETE /api/v1/status-reports/{reportId}/updates/{updateId}", () => {
  it("deletes and returns the refreshed report", async () => {
    const response = await DELETE(request("DELETE"), params)
    expect(response.status).toBe(200)
    expect(deleteReportUpdate).toHaveBeenCalledWith(
      "rep-1",
      "upd-1",
      expect.anything()
    )
    expect((await response.json()).kind).toBe("StatusReport")
    expect(revalidatePath).toHaveBeenCalledWith("/status/reports/rep-1")
  })

  it("maps the last-update guard to 409 LAST_UPDATE", async () => {
    vi.mocked(deleteReportUpdate).mockRejectedValue(
      new StatusReportError("LAST_UPDATE", "keep one")
    )
    const response = await DELETE(request("DELETE"), params)
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe("LAST_UPDATE")
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("maps a missing update to 404 UPDATE_NOT_FOUND", async () => {
    vi.mocked(deleteReportUpdate).mockRejectedValue(
      new StatusReportError("UPDATE_NOT_FOUND", "missing")
    )
    const response = await DELETE(request("DELETE"), params)
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe("UPDATE_NOT_FOUND")
  })

  it("maps UPDATE_NOT_FOUND inside work() itself, not thrown past executeIdempotent (finding: a thrown 404 left the idempotency record stuck 'running' until a stale reclaim, which now simply reruns work() from scratch rather than trying to recover)", async () => {
    vi.mocked(deleteReportUpdate).mockRejectedValue(
      new StatusReportError("UPDATE_NOT_FOUND", "missing")
    )
    const response = await DELETE(request("DELETE"), params)
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe("UPDATE_NOT_FOUND")
  })
})
