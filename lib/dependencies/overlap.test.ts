import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const { dbMock } = vi.hoisted(() => ({ dbMock: { select: vi.fn() } }))
vi.mock("@/lib/db/client", () => ({ db: dbMock }))

import { listOverlappingDependencyIncidents } from "./overlap"

/** A chainable stand-in for `db.select(...).from(...).innerJoin(...).where(...).orderBy(...).limit(...)`, matching the lib/reporting/queries/status.test.ts convention. limit is the terminal call, capping the overlap result set. */
function selectChain(rows: unknown[]) {
  const node = {
    from: () => node,
    innerJoin: () => node,
    where: () => node,
    orderBy: () => node,
    limit: () => Promise.resolve(rows),
  }
  return node
}

beforeEach(() => {
  dbMock.select.mockReset()
})

describe("listOverlappingDependencyIncidents", () => {
  it("maps rows into neutral timing context, preferring the incident's own canonical URL over the source's status page", async () => {
    const row = {
      dependencyId: "dep-1",
      dependencyName: "Vercel Deployments",
      provider: "Vercel",
      incidentId: "pi-1",
      incidentTitle: "Elevated deploy failures",
      providerStartedAt: new Date("2026-07-19T09:57:00.000Z"),
      providerResolvedAt: null,
      canonicalUrl: "https://www.vercel-status.com/incidents/abc",
      statusPageUrl: "https://www.vercel-status.com/",
      matchKind: "component_match",
    }
    dbMock.select.mockReturnValue(selectChain([row]))

    const result = await listOverlappingDependencyIncidents({
      openedAt: new Date("2026-07-19T10:00:00.000Z"),
      resolvedAt: null,
    })

    expect(result).toEqual([
      {
        dependencyId: "dep-1",
        dependencyName: "Vercel Deployments",
        provider: "Vercel",
        incidentId: "pi-1",
        incidentTitle: "Elevated deploy failures",
        providerStartedAt: "2026-07-19T09:57:00.000Z",
        providerResolvedAt: null,
        canonicalUrl: "https://www.vercel-status.com/incidents/abc",
        matchKind: "component_match",
        offsetSeconds: -180,
      },
    ])
  })

  it("falls back to the source's status page URL when the incident has no canonical link", async () => {
    dbMock.select.mockReturnValue(
      selectChain([
        {
          dependencyId: "dep-2",
          dependencyName: "Neon Database",
          provider: "Neon",
          incidentId: "pi-2",
          incidentTitle: "Elevated errors",
          providerStartedAt: new Date("2026-07-19T10:05:00.000Z"),
          providerResolvedAt: new Date("2026-07-19T10:20:00.000Z"),
          canonicalUrl: null,
          statusPageUrl: "https://neonstatus.com",
          matchKind: "inferred",
        },
      ])
    )

    const [overlap] = await listOverlappingDependencyIncidents({
      openedAt: new Date("2026-07-19T10:00:00.000Z"),
      resolvedAt: new Date("2026-07-19T10:30:00.000Z"),
    })

    expect(overlap?.canonicalUrl).toBe("https://neonstatus.com")
    expect(overlap?.offsetSeconds).toBe(300)
  })

  it("returns an empty array when nothing overlaps", async () => {
    dbMock.select.mockReturnValue(selectChain([]))
    const result = await listOverlappingDependencyIncidents({
      openedAt: new Date("2026-07-19T10:00:00.000Z"),
      resolvedAt: null,
    })
    expect(result).toEqual([])
  })
})
