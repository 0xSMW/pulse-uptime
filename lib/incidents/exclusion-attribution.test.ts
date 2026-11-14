import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, it, vi } from "vitest"
import type { DatabaseHandle } from "@/lib/db/client"
import { adminUsers, apiTokens, cliSessions } from "@/lib/db/schema"
import { withExclusionAttribution } from "./exclusion-attribution"
import type { IncidentExclusionRecord } from "./exclusions"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: {} }))

const userId = "11111111-1111-4111-8111-111111111111"
const tokenId = "22222222-2222-4222-8222-222222222222"
const sessionId = "33333333-3333-4333-8333-333333333333"
const deletedId = "44444444-4444-4444-8444-444444444444"
const row = (
  createdByPrincipal: string,
  revertedByPrincipal: string | null = null
): IncidentExclusionRecord => ({
  id: "exclusion",
  incidentId: "incident",
  monitorId: "monitor",
  startAt: "2026-11-13T00:00:00Z",
  endAt: "2026-11-13T00:01:00Z",
  reason: "Maintenance",
  createdByPrincipal,
  createdAt: "2026-11-13T01:00:00Z",
  revertedAt: revertedByPrincipal ? "2026-11-13T02:00:00Z" : null,
  revertedByPrincipal,
  affectedFailedChecks: 1,
})

function database(data: Map<unknown, unknown[]>) {
  const queries: { fields: string[]; params: unknown[] }[] = []
  const select = vi.fn((fields: Record<string, unknown>) => ({
    from: (table: unknown) => {
      const query = {
        innerJoin: () => query,
        leftJoin: () => query,
        where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
          queries.push({
            fields: Object.keys(fields),
            params: new PgDialect().sqlToQuery(condition).params,
          })
          return Promise.resolve(data.get(table) ?? [])
        },
      }
      return query
    },
  }))
  return { handle: { select } as unknown as DatabaseHandle, select, queries }
}

describe("exclusion attribution", () => {
  it("resolves both audit actors in batches without modifying principal keys", async () => {
    const db = database(
      new Map<unknown, unknown[]>([
        [
          adminUsers,
          [{ id: userId, name: "  Stephen  ", email: "stephen@example.com" }],
        ],
        [apiTokens, [{ id: tokenId, name: " Deploy " }]],
        [
          cliSessions,
          [{ id: sessionId, name: null, email: "cli@example.com" }],
        ],
      ])
    )
    const rows = [
      row(`human:${userId}`, `api_token:${tokenId}`),
      row(`human:${userId}`, `cli_session:${sessionId}`),
    ]
    const original = structuredClone(rows)
    const result = await withExclusionAttribution(rows, db.handle)
    expect(
      result.map(({ createdByLabel, revertedByLabel }) => [
        createdByLabel,
        revertedByLabel,
      ])
    ).toEqual([
      ["Stephen", "Deploy (API token)"],
      ["Stephen", "cli@example.com (CLI)"],
    ])
    expect(db.select).toHaveBeenCalledTimes(3)
    expect(db.queries.map((query) => query.params)).toEqual([
      [userId],
      [tokenId],
      [sessionId],
    ])
    expect(db.queries.map((query) => query.fields)).toEqual([
      ["id", "name", "email"],
      ["id", "name"],
      ["id", "name", "email"],
    ])
    expect(rows).toEqual(original)
    for (const [index, attributed] of result.entries()) {
      expect(attributed.createdByPrincipal).toBe(
        rows[index]!.createdByPrincipal
      )
      expect(attributed.revertedByPrincipal).toBe(
        rows[index]!.revertedByPrincipal
      )
    }
  })

  it("uses email for blank names and safe descriptive labels for missing actors", async () => {
    const db = database(
      new Map<unknown, unknown[]>([
        [adminUsers, [{ id: userId, name: "  ", email: " user@example.com " }]],
      ])
    )
    const result = await withExclusionAttribution(
      [
        row(`human:${userId}`),
        row(`human:${deletedId}`, `api_token:${deletedId}`),
        row(`cli_session:${deletedId}`, "human:malformed"),
        row("service:opaque", ""),
      ],
      db.handle
    )
    expect(
      result.map(({ createdByLabel, revertedByLabel }) => [
        createdByLabel,
        revertedByLabel,
      ])
    ).toEqual([
      ["user@example.com", null],
      ["Former user", "Deleted API token"],
      ["Former CLI session", "Unknown actor"],
      ["Unknown actor", "Unknown actor"],
    ])
    expect(db.queries.flatMap((query) => query.params)).not.toContain(
      "malformed"
    )
  })

  it("does not query for unknown or malformed principals", async () => {
    const db = database(new Map())
    await withExclusionAttribution(
      [row("human:invalid", "api_token:invalid"), row("unknown:abc")],
      db.handle
    )
    expect(db.select).not.toHaveBeenCalled()
    expect(await withExclusionAttribution([], db.handle)).toEqual([])
  })
})
