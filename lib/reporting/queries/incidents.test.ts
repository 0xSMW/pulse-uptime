import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { summarizeNotificationAggregate } from "./incidents"

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
