import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  incidentListCondition,
  summarizeNotificationAggregate,
} from "./incidents"

function render(condition: ReturnType<typeof incidentListCondition>) {
  if (!condition) {
    return null
  }
  const query = new PgDialect().sqlToQuery(condition)
  return { sql: query.sql, params: query.params }
}

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
