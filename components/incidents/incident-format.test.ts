import { describe, expect, it } from "vitest"

import { formatIncidentTime, formatIncidentTimeOfDay } from "./incident-format"

describe("incident time formats", () => {
  it("renders the full date-time and the time-only variant in the same zone", () => {
    const value = "2026-07-18T08:43:00.000Z"
    expect(formatIncidentTime(value, "Asia/Bangkok")).toContain("Jul 18, 2026")
    const timeOnly = formatIncidentTimeOfDay(value, "Asia/Bangkok")
    expect(timeOnly).toContain("15:43")
    expect(timeOnly).not.toContain("2026")
  })
})
