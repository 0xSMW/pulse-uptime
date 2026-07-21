import { getTableName } from "drizzle-orm"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

// The db and sql clients are replaced with recorders. Every table a reporting
// query targets through from/leftJoin/innerJoin is captured, so the boundary is
// proven from the queries the exported functions actually build rather than from
// the module source text.
const { dbMock, sqlMock } = vi.hoisted(() => ({
  dbMock: { select: vi.fn() },
  sqlMock: { unsafe: vi.fn() },
}))
vi.mock("@/lib/db/client", () => ({ db: dbMock, sql: sqlMock }))

// Public-status collaborators are stubbed so getPublicStatus reaches its own
// rollup read without their tables entering the recorded set.
vi.mock("@/lib/api/status-page-config", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/api/status-page-config")>()
  return { ...actual, getStatusPageConfig: vi.fn() }
})
vi.mock("@/lib/status-reports/queries", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/status-reports/queries")>()
  return { ...actual, getPublicReports: vi.fn(), requireStatusReport: vi.fn() }
})

import { getStatusPageConfig } from "@/lib/api/status-page-config"
import { monitorRegistry } from "@/lib/db/schema"
import { defaultStatusPageDocument } from "@/lib/status-page/display"
import { getPublicReports } from "@/lib/status-reports/queries"

import { getMonitorDetail, getMonitorLive } from "./monitors"
import { getPublicStatus } from "./status"

// A monitor row wide enough to satisfy both the detail identity select and the
// public-status monitor select, so the query builders proceed past their guard
// clauses into the rollup reads under test.
const MONITOR_ROW = {
  id: "mon-1",
  name: "API",
  url: "https://example.test",
  group: null,
  groupName: null,
  enabled: true,
  state: "UP",
  latestLatencyMs: 100,
  activatedAt: new Date("2026-01-01T00:00:00.000Z"),
  lastCheckedAt: null,
  lastErrorCode: null,
  lastStatusCode: null,
  consecutiveFailures: 0,
}

// The allowed reporting surface after daily_rollups was dropped. Reporting reads
// the rolled-up telemetry and monitor/incident identity through drizzle. Raw
// availability and recent-minute checks decode check_batches only through
// sql.unsafe (never the drizzle surface). check_results stays out of reporting
// reads: it remains the per-execution log for latency and error detail, not the
// availability blend.
const ALLOWED_REPORTING_TABLES = new Set([
  "monitor_registry",
  "monitor_state",
  "metric_rollups",
  "incidents",
  "monitoring_config_snapshots",
])

let captured: Set<unknown>

// Only the monitor registry lookup yields a row, so each builder clears its
// guard and constructs its rollup read. Every other read resolves empty.
function tableRowsFor(table: unknown): unknown[] {
  return table === monitorRegistry ? [MONITOR_ROW] : []
}

// A chainable drizzle stand-in. from and the joins record the target table, and
// the terminal resolution keys off the from-table so identity lookups return a
// monitor while everything else returns no rows.
function makeCapturingChain() {
  let fromTable: unknown
  const settle = () => Promise.resolve(tableRowsFor(fromTable))
  const node: Record<string, unknown> = {
    from(table: unknown) {
      fromTable = table
      captured.add(table)
      return node
    },
    leftJoin(table: unknown) {
      captured.add(table)
      return node
    },
    innerJoin(table: unknown) {
      captured.add(table)
      return node
    },
    where() {
      return node
    },
    orderBy() {
      return node
    },
    limit() {
      return settle()
    },
    then(
      res: (value: unknown[]) => unknown,
      rej?: (reason: unknown) => unknown
    ) {
      return settle().then(res, rej)
    },
    catch(rej: (reason: unknown) => unknown) {
      return settle().catch(rej)
    },
    finally(fn: () => void) {
      return settle().finally(fn)
    },
  }
  return node
}

// Runs a reporting entry point and returns the SQL table names it referenced.
// Query construction records every from/join synchronously before any await, so
// a downstream processing throw over the empty rows leaves the record complete.
async function referencedTables(
  run: () => Promise<unknown>
): Promise<Set<string>> {
  captured = new Set()
  try {
    await run()
  } catch {
    // Table references are captured at build time, ahead of the throw.
  }
  return new Set([...captured].map((table) => getTableName(table as never)))
}

function assertBoundary(tables: Set<string>) {
  expect(tables.has("metric_rollups")).toBe(true)
  // The dropped daily_rollups, check_results, and packed check_batches never
  // enter the drizzle reporting surface. check_batches is read only via raw SQL.
  expect(tables.has("check_batches")).toBe(false)
  expect(tables.has("check_results")).toBe(false)
  expect(tables.has("daily_rollups")).toBe(false)
  for (const table of tables) {
    expect(ALLOWED_REPORTING_TABLES.has(table)).toBe(true)
  }
}

describe("rollup reporting boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbMock.select.mockImplementation(() => makeCapturingChain())
    sqlMock.unsafe.mockResolvedValue([])
  })

  it("monitor detail and live reads target metric_rollups and no legacy raw telemetry", async () => {
    const tables = new Set<string>()
    for (const table of await referencedTables(() =>
      getMonitorDetail("mon-detail")
    )) {
      tables.add(table)
    }
    for (const table of await referencedTables(() =>
      getMonitorLive("mon-live")
    )) {
      tables.add(table)
    }
    assertBoundary(tables)
  })

  it("public status reads target metric_rollups and no legacy raw telemetry", async () => {
    vi.mocked(getStatusPageConfig).mockResolvedValue({
      data: { ...defaultStatusPageDocument(), updatedAt: null, version: 0 },
      etag: '"0"',
    } as never)
    vi.mocked(getPublicReports).mockResolvedValue({
      ongoing: [],
      upcoming: [],
      windowEnded: [],
      resolved: [],
    })
    const tables = await referencedTables(() => getPublicStatus())
    assertBoundary(tables)
  })
})
