import { describe, expect, it } from "vitest"

import {
  formatIncidentTime,
  formatIncidentTimeOfDay,
  sameDayInZone,
} from "./incident-format"

describe("sameDayInZone", () => {
  it("compares calendar days in the display timezone, not UTC", () => {
    // 16:59Z and 17:01Z share a UTC date but straddle midnight in Bangkok (UTC+7).
    const before = "2026-07-18T16:59:00.000Z"
    const after = "2026-07-18T17:01:00.000Z"
    expect(sameDayInZone(before, after, "UTC")).toBe(true)
    expect(sameDayInZone(before, after, "Asia/Bangkok")).toBe(false)
  })

  it("treats instants on the same local day as equal", () => {
    expect(
      sameDayInZone(
        "2026-07-18T08:43:00.000Z",
        "2026-07-18T08:46:00.000Z",
        "Asia/Bangkok"
      )
    ).toBe(true)
  })
})

describe("incident time formats", () => {
  it("renders the full date-time and the time-only variant in the same zone", () => {
    const value = "2026-07-18T08:43:00.000Z"
    expect(formatIncidentTime(value, "Asia/Bangkok")).toContain("Jul 18, 2026")
    const timeOnly = formatIncidentTimeOfDay(value, "Asia/Bangkok")
    expect(timeOnly).toContain("15:43")
    expect(timeOnly).not.toContain("2026")
  })
})
