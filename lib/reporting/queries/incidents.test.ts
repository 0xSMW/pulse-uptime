import type { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

// A recording stand-in for the drizzle client. The list query ends at
// limit() and the notification aggregate ends at groupBy(), so each resolves
// the next queued result set there.
const dbMock = vi.hoisted(() => {
  interface Call {
    fields?: Record<string, unknown>
    leftJoins: Array<{ table: unknown; on: unknown }>
    where?: unknown
    orderBy?: unknown[]
    limit?: number
  }
  interface Chain {
    from: () => Chain
    innerJoin: () => Chain
    leftJoin: (table: unknown, on: unknown) => Chain
    where: (condition: unknown) => Chain
    orderBy: (...columns: unknown[]) => Chain
    limit: (count: number) => Promise<unknown[]>
    groupBy: () => Promise<unknown[]>
  }
  const calls: Call[] = []
  const results: unknown[][] = []
  const next = () => Promise.resolve(results.shift() ?? [])
  const select = (fields?: Record<string, unknown>) => {
    const call: Call = { fields, leftJoins: [] }
    calls.push(call)
    const chain: Chain = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: (table: unknown, on: unknown) => {
        call.leftJoins.push({ table, on })
        return chain
      },
      where: (condition: unknown) => {
        call.where = condition
        return chain
      },
      orderBy: (...columns: unknown[]) => {
        call.orderBy = columns
        return chain
      },
      limit: (count: number) => {
        call.limit = count
        return next()
      },
      groupBy: () => next(),
    }
    return chain
  }
  return { calls, results, db: { select } }
})
vi.mock("@/lib/db/client", () => ({ db: dbMock.db }))
vi.mock("@/lib/incidents/exclusions", () => ({
  loadIncidentExclusionStatuses: async () => new Map(),
}))
vi.mock("@/lib/dependencies/overlap", () => ({
  listOverlappingDependencyIncidents: async () => [],
}))

import { decodeCursor, encodeCursor } from "@/lib/api/pagination"
import { statusReports } from "@/lib/db/schema"
import {
  findIncidentDetail,
  incidentListCondition,
  incidentPage,
  listIncidents,
  parseIncidentListCursor,
  summarizeNotificationAggregate,
} from "./incidents"

function render(condition: SQL | undefined) {
  if (!condition) {
    return null
  }
  const query = new PgDialect().sqlToQuery(condition)
  return { sql: query.sql, params: query.params }
}

afterEach(() => {
  dbMock.calls.length = 0
  dbMock.results.length = 0
})

const TIE = new Date("2026-07-02T00:00:00.000Z")
const ID_A = "33333333-3333-4333-8333-00000000000a"
const ID_B = "33333333-3333-4333-8333-00000000000b"
const KEYSET =
  '("incidents"."opened_at" < $2 or ("incidents"."opened_at" = $3 and "incidents"."id" < $4))'
const REPORT_JOIN = '"status_reports"."origin_incident_id" = "incidents"."id"'

// The report lookup is one left join on the unique origin incident id.
function expectReportJoin(call: (typeof dbMock.calls)[number] | undefined) {
  expect(call?.fields?.reportId).toBe(statusReports.id)
  expect(call?.leftJoins).toHaveLength(1)
  expect(call?.leftJoins[0]?.table).toBe(statusReports)
  expect(render(call?.leftJoins[0]?.on as SQL)?.sql).toBe(REPORT_JOIN)
}

function incidentRow(id: string, openedAt: Date, reportId: string | null) {
  return {
    id,
    monitorId: "public-api",
    monitorName: "Public API",
    openedAt,
    resolvedAt: new Date(openedAt.getTime() + 60_000),
    openingErrorCode: null,
    openingStatusCode: 503,
    reportId,
  }
}

describe("incidentListCondition with a cursor", () => {
  it("continues after the cursor row on opened_at then id, keeping status and monitor filters", () => {
    const rendered = render(
      incidentListCondition("resolved", "public-api", { sort: TIE, id: ID_B })
    )
    expect(rendered?.sql).toBe(
      `("incidents"."resolved_at" is not null and "incidents"."monitor_id" = $1 and ${KEYSET})`
    )
    expect(rendered?.params).toEqual([
      "public-api",
      TIE.toISOString(),
      TIE.toISOString(),
      ID_B,
    ])
  })

  it("keeps the ongoing filter on older pages", () => {
    const rendered = render(
      incidentListCondition("ongoing", null, { sort: TIE, id: ID_B })
    )
    expect(rendered?.sql).toContain('"incidents"."resolved_at" is null')
    expect(rendered?.sql).toContain('"incidents"."id" < $3')
    expect(rendered?.sql).not.toContain("monitor_id")
  })
})

describe("parseIncidentListCursor", () => {
  it("reads a cursor written for the last row of a page", () => {
    const cursor = encodeCursor({ sort: TIE.toISOString(), id: ID_A })
    expect(parseIncidentListCursor(cursor)).toEqual({ sort: TIE, id: ID_A })
  })

  it("falls back to the first page for a missing, empty, or malformed cursor", () => {
    expect(parseIncidentListCursor(undefined)).toBeNull()
    expect(parseIncidentListCursor("")).toBeNull()
    expect(parseIncidentListCursor("not-a-cursor")).toBeNull()
    expect(
      parseIncidentListCursor(encodeCursor({ sort: "yesterday", id: ID_A }))
    ).toBeNull()
  })
})

describe("incidentPage", () => {
  it("returns no cursor when the fetch did not overflow the page", () => {
    const rows = [{ id: ID_B, openedAt: TIE }]
    expect(incidentPage(rows, 1)).toEqual({ page: rows, nextCursor: null })
  })

  it("cuts the extra row and points the cursor at the last visible row, including its id for ties", () => {
    const rows = [
      { id: ID_B, openedAt: TIE },
      { id: ID_A, openedAt: TIE },
    ]
    const { page, nextCursor } = incidentPage(rows, 1)
    expect(page).toEqual([rows[0]])
    expect(decodeCursor(nextCursor)).toEqual({
      sort: TIE.toISOString(),
      id: ID_B,
    })
  })
})

describe("listIncidents", () => {
  it("fetches one row past the page in a stable order and returns the next cursor (finding: a silent limit of 100 hid older incidents)", async () => {
    dbMock.results.push([
      incidentRow(ID_B, TIE, "report-1"),
      incidentRow(ID_A, TIE, null),
    ])
    const result = await listIncidents({
      filter: "resolved",
      monitorId: "public-api",
      limit: 1,
    })

    const [listCall] = dbMock.calls
    expect(listCall?.limit).toBe(2)
    expect(
      listCall?.orderBy?.map((column) => render(column as SQL)?.sql)
    ).toEqual(['"incidents"."opened_at" desc', '"incidents"."id" desc'])
    expect(result.data.map((incident) => incident.id)).toEqual([ID_B])
    expect(decodeCursor(result.nextCursor)).toEqual({
      sort: TIE.toISOString(),
      id: ID_B,
    })
  })

  it("passes the cursor and filters into the list query", async () => {
    dbMock.results.push([])
    const result = await listIncidents({
      filter: "resolved",
      monitorId: "public-api",
      cursor: { sort: TIE, id: ID_B },
    })
    const rendered = render(dbMock.calls[0]?.where as SQL)
    expect(rendered?.sql).toContain('"incidents"."resolved_at" is not null')
    expect(rendered?.sql).toContain('"incidents"."monitor_id" = $1')
    expect(rendered?.sql).toContain(KEYSET)
    expect(result).toEqual({ data: [], nextCursor: null })
  })

  it("carries an existing report id so the row can link to it", async () => {
    dbMock.results.push(
      [incidentRow(ID_B, TIE, "report-1"), incidentRow(ID_A, TIE, null)],
      []
    )
    const { data } = await listIncidents()
    expect(data.map((incident) => incident.reportId)).toEqual([
      "report-1",
      null,
    ])
    expectReportJoin(dbMock.calls[0])
  })
})

describe("findIncidentDetail", () => {
  function detailRow(reportId: string | null) {
    return {
      ...incidentRow(ID_B, TIE, reportId),
      firstFailureAt: TIE,
      firstSuccessAt: null,
    }
  }

  it("carries an existing report id through the same report join as the list", async () => {
    dbMock.results.push([detailRow("report-1")], [])
    const detail = await findIncidentDetail(ID_B)
    expect(detail?.reportId).toBe("report-1")
    expectReportJoin(dbMock.calls[0])
    expect(dbMock.calls[0]?.limit).toBe(1)
  })

  it("returns a null report id when the incident has no report", async () => {
    dbMock.results.push([detailRow(null)], [])
    expect((await findIncidentDetail(ID_B))?.reportId).toBeNull()
  })
})

describe("incidentListCondition", () => {
  it("adds no condition for all incidents across monitors", () => {
    expect(render(incidentListCondition("all"))).toBeNull()
  })

  it("filters to one monitor without a status filter", () => {
    expect(render(incidentListCondition("all", "public-api"))).toEqual({
      sql: '"incidents"."monitor_id" = $1',
      params: ["public-api"],
    })
  })

  it("keeps the monitor filter alongside ongoing", () => {
    const rendered = render(incidentListCondition("ongoing", "public-api"))
    expect(rendered?.sql).toContain('"incidents"."resolved_at" is null')
    expect(rendered?.sql).toContain('"incidents"."monitor_id" = $1')
    expect(rendered?.params).toEqual(["public-api"])
  })

  it("keeps the monitor filter alongside resolved", () => {
    const rendered = render(incidentListCondition("resolved", "public-api"))
    expect(rendered?.sql).toContain('"incidents"."resolved_at" is not null')
    expect(rendered?.sql).toContain('"incidents"."monitor_id" = $1')
    expect(rendered?.params).toEqual(["public-api"])
  })

  it("filters status alone when no monitor is given", () => {
    const rendered = render(incidentListCondition("resolved"))
    expect(rendered?.sql).toContain('"incidents"."resolved_at" is not null')
    expect(rendered?.sql).not.toContain("monitor_id")
  })
})

describe("summarizeNotificationAggregate", () => {
  it("reports none when an incident has no notifications", () => {
    expect(
      summarizeNotificationAggregate({
        sentCount: 0,
        anyDead: false,
        anyUnsent: false,
      })
    ).toEqual({ state: "none", sentCount: 0 })
  })

  it("reports sent when every notification succeeded", () => {
    expect(
      summarizeNotificationAggregate({
        sentCount: 3,
        anyDead: false,
        anyUnsent: false,
      })
    ).toEqual({ state: "sent", sentCount: 3 })
  })

  it("reports retrying while any notification is still unsent", () => {
    expect(
      summarizeNotificationAggregate({
        sentCount: 1,
        anyDead: false,
        anyUnsent: true,
      })
    ).toEqual({ state: "retrying", sentCount: 1 })
  })

  it("dead wins over retrying and sent", () => {
    expect(
      summarizeNotificationAggregate({
        sentCount: 2,
        anyDead: true,
        anyUnsent: true,
      })
    ).toEqual({ state: "dead", sentCount: 2 })
  })
})
