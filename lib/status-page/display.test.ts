import { describe, expect, it } from "vitest"

import type { TimelineBucket } from "@/lib/monitoring/types"

import {
  defaultStatusPageDocument,
  displayTimelineBuckets,
  filterShortResolvedIncidents,
  formatStatusClock,
  formatStatusTimestamp,
  formatUptimePercent,
  historyWindowStart,
  imageDataUri,
  statusAssetUrl,
  timezoneDisplay,
  timezoneOffsetLabel,
} from "./display"

describe("defaultStatusPageDocument", () => {
  it("falls back to the historical runtime literal", () => {
    expect(defaultStatusPageDocument({}).name).toBe("Pulse Status")
  })

  it("prefers the trimmed env page name", () => {
    expect(
      defaultStatusPageDocument({
        NEXT_PUBLIC_STATUS_PAGE_NAME: "  Acme Status ",
      }).name
    ).toBe("Acme Status")
  })

  it("matches the schema defaults for the history math", () => {
    const document = defaultStatusPageDocument({})
    expect(document.historyDays).toBe(90)
    expect(document.uptimeDecimals).toBe(2)
    expect(document.unknownAsOperational).toBe(false)
    expect(document.minIncidentSeconds).toBe(0)
    expect(document.timezone).toBeNull()
  })
})

describe("timezoneDisplay", () => {
  const at = new Date("2026-07-18T12:00:00.000Z")

  it("defaults to UTC labeled exactly as before", () => {
    expect(timezoneDisplay(null, at)).toEqual({
      timeZone: "UTC",
      short: "UTC",
      full: "UTC",
    })
    expect(timezoneDisplay("UTC", at)).toEqual({
      timeZone: "UTC",
      short: "UTC",
      full: "UTC",
    })
  })

  it("labels a configured zone with its offset and name", () => {
    expect(timezoneDisplay("Asia/Bangkok", at)).toEqual({
      timeZone: "Asia/Bangkok",
      short: "GMT+7",
      full: "GMT+7 · Asia/Bangkok",
    })
  })

  it("falls back to UTC for an invalid zone", () => {
    expect(timezoneDisplay("Not/A_Zone", at)).toEqual({
      timeZone: "UTC",
      short: "UTC",
      full: "UTC",
    })
  })
})

describe("timezoneOffsetLabel", () => {
  it("computes the offset for the GIVEN instant, not a fixed page-load time (finding: DST rows showed a stale offset)", () => {
    // America/New_York springs forward on 2026-03-08: EST (GMT-5) before,
    // EDT (GMT-4) after. A helper that reused one offset for every row would
    // mislabel one side of the boundary.
    expect(
      timezoneOffsetLabel(
        "America/New_York",
        new Date("2026-03-01T12:00:00.000Z")
      )
    ).toBe("GMT-5")
    expect(
      timezoneOffsetLabel(
        "America/New_York",
        new Date("2026-03-15T12:00:00.000Z")
      )
    ).toBe("GMT-4")
  })

  it("stays UTC regardless of instant (default behavior unchanged)", () => {
    expect(
      timezoneOffsetLabel(null, new Date("2026-03-01T12:00:00.000Z"))
    ).toBe("UTC")
    expect(
      timezoneOffsetLabel("UTC", new Date("2026-03-15T12:00:00.000Z"))
    ).toBe("UTC")
  })
})

describe("timestamp formatting", () => {
  it("formats in the requested zone", () => {
    expect(formatStatusTimestamp("2026-07-18T12:00:00.000Z", "UTC")).toBe(
      "Jul 18, 12:00"
    )
    expect(
      formatStatusTimestamp("2026-07-18T18:30:00.000Z", "Asia/Bangkok")
    ).toBe("Jul 19, 01:30")
    expect(formatStatusClock("2026-07-18T12:00:05.000Z", "Asia/Bangkok")).toBe(
      "19:00:05"
    )
  })

  it("degrades gracefully on malformed input", () => {
    expect(formatStatusTimestamp("not-a-date", "UTC")).toBe("Unavailable")
    expect(formatStatusClock("not-a-date", "UTC")).toBe("Unavailable")
  })
})

describe("formatUptimePercent", () => {
  it("applies the configured decimal places as a maximum, trimming trailing zeros", () => {
    expect(formatUptimePercent(99.987_65, 0)).toBe("100%")
    expect(formatUptimePercent(99.987_65, 2)).toBe("99.99%")
    expect(formatUptimePercent(99.987_65, 3)).toBe("99.988%")
    expect(formatUptimePercent(100, 2)).toBe("100%")
    expect(formatUptimePercent(99.9, 3)).toBe("99.9%")
  })

  it("clamps out-of-range decimals and keeps the null placeholder", () => {
    expect(formatUptimePercent(99.5, 7)).toBe("99.5%")
    expect(formatUptimePercent(99.5, -1)).toBe("100%")
    expect(formatUptimePercent(null, 2)).toBe("—")
  })
})

describe("filterShortResolvedIncidents", () => {
  const incidents = [
    { id: "a", durationSeconds: 30 },
    { id: "b", durationSeconds: 300 },
    { id: "c", durationSeconds: 3000 },
  ]

  it("keeps everything when the floor is zero", () => {
    expect(filterShortResolvedIncidents(incidents, 0)).toHaveLength(3)
  })

  it("hides resolved blips shorter than the floor", () => {
    expect(
      filterShortResolvedIncidents(incidents, 300).map(
        (incident) => incident.id
      )
    ).toEqual(["b", "c"])
  })
})

describe("displayTimelineBuckets", () => {
  const buckets: TimelineBucket[] = [
    { state: "up", label: "day-1", checks: 10, failures: 0 },
    { state: "no-data", label: "day-2", checks: 0, failures: 0 },
    { state: "down", label: "day-3", checks: 10, failures: 10 },
  ]

  it("passes buckets through unchanged by default", () => {
    expect(displayTimelineBuckets(buckets, false)).toEqual(buckets)
  })

  it("maps unknown buckets to operational styling when configured", () => {
    const mapped = displayTimelineBuckets(buckets, true)
    expect(mapped.map((bucket) => bucket.state)).toEqual(["up", "up", "down"])
    // Down and verifying buckets are never touched. Labels are preserved.
    expect(mapped[1]!.label).toBe("day-2")
  })
})

describe("historyWindowStart", () => {
  const completedDay = new Date("2026-07-18T00:00:00.000Z")

  it("derives the fetch window from the configured history days", () => {
    expect(historyWindowStart(90, completedDay).toISOString()).toBe(
      "2026-04-19T00:00:00.000Z"
    )
    expect(historyWindowStart(30, completedDay).toISOString()).toBe(
      "2026-06-18T00:00:00.000Z"
    )
  })
})

describe("asset helpers", () => {
  it("builds a base64 data URI from image bytes", () => {
    expect(imageDataUri("image/png", new Uint8Array([137, 80, 78, 71]))).toBe(
      "data:image/png;base64,iVBORw=="
    )
  })

  it("points at the public status asset route", () => {
    expect(statusAssetUrl("11111111-1111-4111-8111-111111111111")).toBe(
      "/status/assets/11111111-1111-4111-8111-111111111111"
    )
  })
})
