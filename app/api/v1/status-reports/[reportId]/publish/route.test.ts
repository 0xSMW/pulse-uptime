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
  publishStatusReport: vi.fn(),
}))

import { revalidatePath } from "next/cache"

import { executeIdempotent } from "@/lib/api/idempotency"
import { type ApiContext, authorize } from "@/lib/api/middleware"
import {
  publishStatusReport,
  type StatusReportData,
  StatusReportError,
} from "@/lib/api/status-reports"

import { POST } from "./route"

const context: ApiContext = {
  principal: {
    type: "cli_session",
    id: "cli-1",
    email: "admin@example.com",
    scopes: ["reports:write"],
    expiresAt: new Date(),
    installation: {
      id: "ins-1",
      displayName: "Mac",
      platform: "darwin",
      architecture: "arm64",
      clientVersion: "1.0.0",
      linkedAt: new Date(),
    },
  },
  principalKey: "cli_session:cli-1",
  requestId: "req_publish",
}

const report: StatusReportData = {
  id: "rep-1",
  type: "incident",
  title: "API outage",
  startsAt: "2026-07-18T09:00:00.000Z",
  endsAt: null,
  publishedAt: "2026-07-18T12:00:00.000Z",
  resolvedAt: null,
  originIncidentId: null,
  currentStatus: "investigating",
  updates: [
    {
      id: "upd-1",
      status: "investigating",
      markdown: "Looking.",
      publishedAt: "2026-07-18T09:05:00.000Z",
      createdAt: "2026-07-18T09:05:00.000Z",
    },
  ],
  updatesCount: 1,
  updatesNextCursor: null,
  affected: [],
  createdAt: "2026-07-18T09:05:00.000Z",
  updatedAt: "2026-07-18T12:00:00.000Z",
}

function request() {
  return new Request("https://pulse.test/api/v1/status-reports/rep-1/publish", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
  })
}

const params = { params: Promise.resolve({ reportId: "rep-1" }) }

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context)
  vi.mocked(revalidatePath).mockReset()
  vi.mocked(publishStatusReport).mockReset().mockResolvedValue(report)
  vi.mocked(executeIdempotent).mockClear()
})

describe("POST /api/v1/status-reports/{reportId}/publish", () => {
  it("requires reports:write, publishes, and revalidates the public pages", async () => {
    const response = await POST(request(), params)
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), {
      scope: "reports:write",
    })
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.kind).toBe("StatusReport")
    expect(payload.data.publishedAt).toBe("2026-07-18T12:00:00.000Z")
    expect(publishStatusReport).toHaveBeenCalledWith("rep-1", expect.anything())
    expect(revalidatePath).toHaveBeenCalledWith("/status")
    expect(revalidatePath).toHaveBeenCalledWith("/status/reports/rep-1")
  })

  it("maps a second publish to 409 ALREADY_PUBLISHED", async () => {
    vi.mocked(publishStatusReport).mockRejectedValue(
      new StatusReportError("ALREADY_PUBLISHED", "already")
    )
    const response = await POST(request(), params)
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe("ALREADY_PUBLISHED")
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("maps a missing report to 404", async () => {
    vi.mocked(publishStatusReport).mockRejectedValue(
      new StatusReportError("REPORT_NOT_FOUND", "missing")
    )
    const response = await POST(request(), params)
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe("REPORT_NOT_FOUND")
  })

  it("maps ALREADY_PUBLISHED and REPORT_NOT_FOUND inside work() itself, not thrown past executeIdempotent (finding: a thrown deterministic error left the idempotency record stuck 'running' until a stale reclaim, which now simply reruns work() from scratch rather than trying to recover)", async () => {
    vi.mocked(publishStatusReport).mockRejectedValue(
      new StatusReportError("ALREADY_PUBLISHED", "already")
    )
    let response = await POST(request(), params)
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe("ALREADY_PUBLISHED")

    vi.mocked(publishStatusReport).mockRejectedValue(
      new StatusReportError("REPORT_NOT_FOUND", "missing")
    )
    response = await POST(request(), params)
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe("REPORT_NOT_FOUND")
  })
})
