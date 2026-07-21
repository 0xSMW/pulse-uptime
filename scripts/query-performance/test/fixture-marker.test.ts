import { describe, expect, it } from "vitest"
import type { GatedConnection } from "../src/db-connection"
import {
  deleteFixtureMarker,
  FIXTURE_CLOCK,
  resetFixture,
  seedFixture,
} from "../src/fixtures"

interface LogEntry {
  type: "unsafe" | "delete-marker" | "insert-marker" | "delete" | "insert"
  table?: unknown
  rowCount?: number
  text?: string
  values?: unknown[]
}

function fakeConn(): { conn: GatedConnection; log: LogEntry[] } {
  const log: LogEntry[] = []

  const db = {
    delete(table: unknown) {
      return {
        where() {
          log.push({ type: "delete", table })
          return Promise.resolve()
        },
      }
    },
    insert(table: unknown) {
      return {
        values(rows: unknown) {
          const rowArray = Array.isArray(rows) ? rows : [rows]
          log.push({ type: "insert", table, rowCount: rowArray.length })
          return Promise.resolve()
        },
      }
    },
  }

  // Supports tagged SQL calls and unsafe statements used by the fixture helpers.
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?")
    if (text.includes('delete from "_query_perf_fixture"')) {
      log.push({ type: "delete-marker", text, values })
    } else if (text.includes('insert into "_query_perf_fixture"')) {
      log.push({ type: "insert-marker", text, values })
    }
    return Promise.resolve([])
  }) as unknown as GatedConnection["sql"]
  ;(sql as unknown as { unsafe: (text: string) => Promise<unknown[]> }).unsafe =
    () => {
      log.push({ type: "unsafe" })
      return Promise.resolve([])
    }

  return {
    conn: {
      db,
      sql,
      project: {
        projectId: "fake-project",
        regionId: "fake-region",
        database: "fake",
      },
    } as unknown as GatedConnection,
    log,
  }
}

describe("deleteFixtureMarker", () => {
  it("issues a delete against the marker table for the qh-fixture tag", async () => {
    const { conn, log } = fakeConn()
    await deleteFixtureMarker(conn)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      type: "delete-marker",
      values: ["qh-fixture"],
    })
  })
})

describe("seedFixture marker invalidation sequencing", () => {
  it("invalidates the marker before any fixture table is reset, and re-inserts it only after every seed write completes", async () => {
    const { conn, log } = fakeConn()
    await seedFixture(conn)

    const deleteMarkerIndex = log.findIndex(
      (entry) => entry.type === "delete-marker"
    )
    const firstResetDeleteIndex = log.findIndex(
      (entry) => entry.type === "delete"
    )
    const firstInsertIndex = log.findIndex((entry) => entry.type === "insert")
    const insertMarkerIndex = log.findIndex(
      (entry) => entry.type === "insert-marker"
    )

    expect(deleteMarkerIndex).toBeGreaterThanOrEqual(0)
    expect(insertMarkerIndex).toBeGreaterThanOrEqual(0)
    // The marker must be invalidated before fixture data changes.
    expect(deleteMarkerIndex).toBeLessThan(firstResetDeleteIndex)
    expect(deleteMarkerIndex).toBeLessThan(firstInsertIndex)
    expect(insertMarkerIndex).toBe(log.length - 1)
  })
})

describe("seedFixture marker clock", () => {
  it("writes the fixture clock into seeded_at instead of relying on database now()", async () => {
    const { conn, log } = fakeConn()
    await seedFixture(conn)

    const insertMarker = log.find((entry) => entry.type === "insert-marker")
    expect(insertMarker).toBeDefined()

    // The insert must bind seeded_at explicitly to the clock used for rows.
    expect(insertMarker!.text).toContain(
      "(tag, version, seeded_at, cardinalities)"
    )
    const boundDates = insertMarker!.values!.filter(
      (value): value is Date => value instanceof Date
    )
    expect(boundDates).toHaveLength(1)
    expect(boundDates[0]!.getTime()).toBe(FIXTURE_CLOCK.getTime())

    // The conflict branch must preserve the bound clock rather than reset it.
    expect(insertMarker!.text).toContain("seeded_at = excluded.seeded_at")
    expect(insertMarker!.text).not.toContain("seeded_at = now()")
  })
})

describe("resetFixture marker invalidation sequencing", () => {
  it("invalidates the marker before deleting any fixture-tagged row", async () => {
    const { conn, log } = fakeConn()
    await resetFixture(conn)

    const deleteMarkerIndex = log.findIndex(
      (entry) => entry.type === "delete-marker"
    )
    const firstResetDeleteIndex = log.findIndex(
      (entry) => entry.type === "delete"
    )

    expect(deleteMarkerIndex).toBeGreaterThanOrEqual(0)
    expect(deleteMarkerIndex).toBeLessThan(firstResetDeleteIndex)
    expect(log.some((entry) => entry.type === "insert-marker")).toBe(false)
  })
})
