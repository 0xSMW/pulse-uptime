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
  requireStatusReport: vi.fn(),
  updateStatusReport: vi.fn(),
  deleteStatusReport: vi.fn(),
}))

import { revalidatePath } from "next/cache"

import { executeIdempotent } from "@/lib/api/idempotency"
import { type ApiContext, authorize } from "@/lib/api/middleware"
import {
  deleteStatusReport,
  requireStatusReport,
  type StatusReportData,
  StatusReportError,
  updateStatusReport,
} from "@/lib/api/status-reports"

import { DELETE, GET, PATCH } from "./route"

const context: ApiContext = {
  principal: {
    type: "human",
    id: "usr-1",
    email: "admin@example.com",
    scopes: ["reports:read", "reports:write"],
  },
  principalKey: "human:usr-1",
  requestId: "req_report",
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
  currentStatus: "investigating",
  updates: [
    {
      id: "upd-1",
      status: "investigating",
      markdown: "Looking into it.",
      publishedAt: "2026-07-18T09:05:00.000Z",
      createdAt: "2026-07-18T09:05:00.000Z",
    },
  ],
  updatesCount: 1,
  updatesNextCursor: null,
  affected: [
    {
      monitorId: "api-prod",
      monitorName: "API",
      groupName: "Core",
      impact: "down",
    },
  ],
  createdAt: "2026-07-18T09:05:00.000Z",
  updatedAt: "2026-07-18T09:05:00.000Z",
}

const params = { params: Promise.resolve({ reportId: "rep-1" }) }

function request(method: string, body?: unknown) {
  return new Request("https://pulse.test/api/v1/status-reports/rep-1", {
    method,
    headers: { "Idempotency-Key": crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context)
  vi.mocked(revalidatePath).mockReset()
  vi.mocked(requireStatusReport).mockReset().mockResolvedValue(report)
  vi.mocked(updateStatusReport).mockReset().mockResolvedValue(report)
  vi.mocked(deleteStatusReport).mockReset().mockResolvedValue({ id: "rep-1" })
  vi.mocked(executeIdempotent).mockClear()
})

describe("GET /api/v1/status-reports/{reportId}", () => {
  it("requires reports:read and returns the report envelope", async () => {
    const response = await GET(request("GET"), params)
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), {
      scope: "reports:read",
    })
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.kind).toBe("StatusReport")
    expect(payload.data).toEqual(report)
  })

  it("maps REPORT_NOT_FOUND to 404", async () => {
    vi.mocked(requireStatusReport).mockRejectedValue(
      new StatusReportError("REPORT_NOT_FOUND", "missing")
    )
    const response = await GET(request("GET"), params)
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe("REPORT_NOT_FOUND")
  })
})

describe("PATCH /api/v1/status-reports/{reportId}", () => {
  it("requires reports:write, applies the patch, and revalidates", async () => {
    const response = await PATCH(
      request("PATCH", { title: "New title" }),
      params
    )
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), {
      scope: "reports:write",
    })
    expect(response.status).toBe(200)
    expect(updateStatusReport).toHaveBeenCalledWith(
      "rep-1",
      { title: "New title" },
      expect.anything()
    )
    expect(revalidatePath).toHaveBeenCalledWith("/status")
    expect(revalidatePath).toHaveBeenCalledWith("/status/reports/rep-1")
    expect(revalidatePath).toHaveBeenCalledWith("/status/core")
  })

  it("maps validation failures to 400", async () => {
    vi.mocked(updateStatusReport).mockRejectedValue(
      new StatusReportError("VALIDATION_ERROR", "empty patch")
    )
    const response = await PATCH(request("PATCH", {}), params)
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR")
  })

  it("revalidates both the pre-patch and post-patch group pages when affected is replaced", async () => {
    vi.mocked(requireStatusReport).mockResolvedValue({
      ...report,
      affected: [
        {
          monitorId: "db-prod",
          monitorName: "Database",
          groupName: "Data",
          impact: "down",
        },
      ],
    })
    const response = await PATCH(
      request("PATCH", {
        affected: [{ monitorId: "api-prod", impact: "down" }],
      }),
      params
    )
    expect(response.status).toBe(200)
    // Post-patch group (from the mutation result) and pre-patch group (from
    // the pre-image) both refresh so the report never lingers on a page it left.
    expect(revalidatePath).toHaveBeenCalledWith("/status/core")
    expect(revalidatePath).toHaveBeenCalledWith("/status/data")
  })

  it("maps VALIDATION_ERROR inside work() itself, not thrown past executeIdempotent (finding: a thrown error left the idempotency record stuck 'running' until a stale reclaim, which now simply reruns work() from scratch rather than trying to recover)", async () => {
    vi.mocked(updateStatusReport).mockRejectedValue(
      new StatusReportError(
        "VALIDATION_ERROR",
        "Provide at least one field to update"
      )
    )
    const response = await PATCH(request("PATCH", {}), params)
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR")
  })
})

describe("DELETE /api/v1/status-reports/{reportId}", () => {
  it("deletes, revalidates, and returns a 200 deletion envelope", async () => {
    const response = await DELETE(request("DELETE"), params)
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.kind).toBe("StatusReportDeleted")
    expect(payload.data).toEqual({ id: "rep-1" })
    expect(deleteStatusReport).toHaveBeenCalledWith("rep-1", expect.anything())
    expect(revalidatePath).toHaveBeenCalledWith("/status")
  })

  it("maps a missing report to 404", async () => {
    vi.mocked(requireStatusReport).mockRejectedValue(
      new StatusReportError("REPORT_NOT_FOUND", "missing")
    )
    const response = await DELETE(request("DELETE"), params)
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe("REPORT_NOT_FOUND")
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("maps REPORT_NOT_FOUND inside work() itself, not thrown past executeIdempotent (finding: a thrown 404 left the idempotency record stuck 'running' until a stale reclaim, which now simply reruns work() from scratch rather than trying to recover)", async () => {
    vi.mocked(requireStatusReport).mockRejectedValue(
      new StatusReportError("REPORT_NOT_FOUND", "missing")
    )
    const response = await DELETE(request("DELETE"), params)
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe("REPORT_NOT_FOUND")
  })
})
