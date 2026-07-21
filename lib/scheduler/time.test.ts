import { describe, expect, it } from "vitest"

import { isDueAt, scheduledMinuteAt } from "./time"

describe("scheduler time alignment", () => {
  it("aligns a run to its stable UTC minute", () => {
    expect(
      scheduledMinuteAt(new Date("2026-07-18T04:07:59.999Z")).toISOString()
    ).toBe("2026-07-18T04:07:00.000Z")
  })

  it.each([
    1, 5, 10, 15,
  ] as const)("aligns %i-minute monitors to the epoch", (intervalMinutes) => {
    expect(
      isDueAt(
        { enabled: true, intervalMinutes },
        new Date("2026-07-18T04:00:00Z")
      )
    ).toBe(true)
    if (intervalMinutes > 1) {
      expect(
        isDueAt(
          { enabled: true, intervalMinutes },
          new Date("2026-07-18T04:01:00Z")
        )
      ).toBe(false)
    }
  })

  it("never schedules disabled monitors", () => {
    expect(
      isDueAt(
        { enabled: false, intervalMinutes: 1 },
        new Date("2026-07-18T04:00:00Z")
      )
    ).toBe(false)
  })
})
