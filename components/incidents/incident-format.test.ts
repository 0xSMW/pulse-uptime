import { describe, expect, it } from "vitest"

import {
  formatIncidentRange,
  formatIncidentTime,
  formatIncidentTimeOfDay,
} from "./incident-format"

describe("incident time formats", () => {
  it("renders the full date-time and the time-only variant in the same zone", () => {
    const value = "2026-07-18T08:43:00.000Z"
    expect(formatIncidentTime(value, "Asia/Bangkok")).toContain("Jul 18, 2026")
    const timeOnly = formatIncidentTimeOfDay(value, "Asia/Bangkok")
    expect(timeOnly).toContain("15:43")
    expect(timeOnly).not.toContain("2026")
  })
})

describe("incident interval formats", () => {
  it("shares the local date even when the interval crosses UTC midnight", () => {
    expect(
      formatIncidentRange(
        "2026-11-13T19:00:00Z",
        "2026-11-14T06:16:00Z",
        "America/Los_Angeles"
      )
    ).toBe("Nov 13, 11:00–22:16 PST")
  })

  it("retains both dates when the interval crosses local midnight", () => {
    expect(
      formatIncidentRange("2026-11-13T23:00:00Z", "2026-11-14T00:16:00Z")
    ).toBe("Nov 13, 23:00–Nov 14, 00:16 UTC")
  })

  it("retains both years at a year boundary", () => {
    expect(
      formatIncidentRange("2026-12-31T23:00:00Z", "2027-01-01T01:00:00Z")
    ).toBe("Dec 31, 2026, 23:00–Jan 1, 2027, 01:00 UTC")
  })

  it("distinguishes repeated times when daylight saving ends", () => {
    expect(
      formatIncidentRange(
        "2026-11-01T08:30:00Z",
        "2026-11-01T09:30:00Z",
        "America/Los_Angeles"
      )
    ).toBe("Nov 1, 01:30 PDT–01:30 PST")
  })
})
