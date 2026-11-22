import postgres from "postgres"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

const { enforceRateLimit, requireStatusReport, listStatusReportUpdates } =
  vi.hoisted(() => {
    if (process.env.TEST_DATABASE_URL) {
      process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
    }
    return {
      enforceRateLimit: vi.fn(),
      requireStatusReport: vi.fn(),
      listStatusReportUpdates: vi.fn(),
    }
  })

vi.mock("server-only", () => ({}))
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "x-real-ip": "203.0.113.10" })),
}))
vi.mock("@/lib/api/rate-limit", () => ({ enforceRateLimit }))
vi.mock("@/lib/api/status-reports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/status-reports")>()),
  requireStatusReport,
  listStatusReportUpdates,
}))
vi.mock("@/lib/markdown/restricted", () => ({
  renderRestrictedMarkdown: vi.fn((value: string) => value),
}))

import { renderRestrictedMarkdown } from "@/lib/markdown/restricted"
import { loadPublicReportUpdates } from "./load-public-report-updates"

describe("public report update admission", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("API_TOKEN_HASH_KEY", "a".repeat(32))
    requireStatusReport.mockResolvedValue({
      publishedAt: "2026-11-14T00:00:00Z",
    })
    listStatusReportUpdates.mockResolvedValue({ data: [], nextCursor: null })
  })

  it("rejects a limited anonymous caller before looking up a report", async () => {
    enforceRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 30,
    })

    await expect(
      loadPublicReportUpdates(crypto.randomUUID(), "cursor")
    ).rejects.toThrow("Too many requests")
    expect(requireStatusReport).not.toHaveBeenCalled()
    expect(listStatusReportUpdates).not.toHaveBeenCalled()
  })

  it("loads a published report after admission and rejects a draft", async () => {
    enforceRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 59,
      retryAfterSeconds: 60,
    })
    const reportId = crypto.randomUUID()

    await expect(loadPublicReportUpdates(reportId, "cursor")).resolves.toEqual({
      data: [],
      nextCursor: null,
    })
    expect(enforceRateLimit).toHaveBeenCalledWith(
      expect.stringMatching(/^ip:[a-f0-9]{64}$/),
      expect.objectContaining({ routeKey: "public-report-updates" })
    )
    expect(listStatusReportUpdates).toHaveBeenCalledWith(reportId, {
      cursor: "cursor",
      limit: 50,
    })

    requireStatusReport.mockResolvedValueOnce({ publishedAt: null })
    await expect(loadPublicReportUpdates(reportId, "cursor")).rejects.toThrow()
    expect(listStatusReportUpdates).toHaveBeenCalledTimes(1)
  })
})

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const databaseSuite = testDatabaseUrl ? describe : describe.skip

databaseSuite("public report action with the PostgreSQL report service", () => {
  const fixtureDb = postgres(testDatabaseUrl!, { max: 1, prepare: false })
  let closeServiceDb: () => Promise<void>
  let realRequireStatusReport: typeof import("@/lib/api/status-reports").requireStatusReport

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl
    const reports = await vi.importActual<
      typeof import("@/lib/api/status-reports")
    >("@/lib/api/status-reports")
    const markdown = await vi.importActual<
      typeof import("@/lib/markdown/restricted")
    >("@/lib/markdown/restricted")
    const { sql } = await import("@/lib/db/client")
    closeServiceDb = () => sql.end()
    realRequireStatusReport = reports.requireStatusReport
    requireStatusReport.mockImplementation(reports.requireStatusReport)
    listStatusReportUpdates.mockImplementation(reports.listStatusReportUpdates)
    vi.mocked(renderRestrictedMarkdown).mockImplementation(
      markdown.renderRestrictedMarkdown
    )
  })

  afterAll(async () => {
    await closeServiceDb()
    await fixtureDb.end()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("API_TOKEN_HASH_KEY", "a".repeat(32))
    enforceRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 59,
      retryAfterSeconds: 60,
    })
  })

  async function seedReport(published: boolean, updateCount: number) {
    const reportId = crypto.randomUUID()
    const base = Date.parse("2026-11-14T00:00:00.000Z")
    const createdAt = new Date(base)
    await fixtureDb`
      insert into status_reports
        (id, type, title, starts_at, published_at, created_at, updated_at)
      values
        (${reportId}, 'incident', 'Security action fixture', ${createdAt},
         ${published ? createdAt : null}, ${createdAt}, ${createdAt})
    `
    for (let index = 0; index < updateCount; index += 1) {
      const at = new Date(base + (index + 1) * 60_000)
      const markdown =
        index === 0
          ? "<img src=x onerror=alert(1)> **bold**"
          : `Update ${index + 1}`
      await fixtureDb`
        insert into status_report_updates
          (id, report_id, status, markdown, published_at, created_at, updated_at)
        values
          (${crypto.randomUUID()}, ${reportId}, 'investigating', ${markdown},
           ${at}, ${at}, ${at})
      `
    }
    return reportId
  }

  it("denies an unpublished report that exists in the database", async () => {
    const reportId = await seedReport(false, 1)
    try {
      expect((await realRequireStatusReport(reportId)).updatesCount).toBe(1)
      await expect(loadPublicReportUpdates(reportId, "cursor")).rejects.toThrow(
        "Status report was not found"
      )
      expect(listStatusReportUpdates).not.toHaveBeenCalled()
    } finally {
      await fixtureDb`delete from status_reports where id = ${reportId}`
    }
  })

  it("paginates published updates and renders old markdown as safe HTML", async () => {
    const reportId = await seedReport(true, 52)
    try {
      const report = await realRequireStatusReport(reportId)
      expect(report.updatesCount).toBe(52)
      expect(report.updatesNextCursor).toBeTruthy()

      const older = await loadPublicReportUpdates(
        reportId,
        report.updatesNextCursor!
      )
      expect(older.data).toHaveLength(2)
      expect(older.nextCursor).toBeNull()
      expect(older.data[0]?.html).toContain("Update 2")
      expect(older.data[1]?.html).toContain("&lt;img")
      expect(older.data[1]?.html).toContain("<strong>bold</strong>")
      expect(older.data[1]?.html).not.toContain("<img")
    } finally {
      await fixtureDb`delete from status_reports where id = ${reportId}`
    }
  })
})
