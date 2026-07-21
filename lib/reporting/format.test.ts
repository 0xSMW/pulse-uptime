import { describe, expect, it } from "vitest"
import {
  formatBucketTimeRange,
  formatDuration,
  formatLatency,
  formatRelativeDay,
  formatRelativeTime,
  formatUptimeDetail,
  formatUptimeTable,
} from "./format"

describe("report formatting", () => {
  it("formats uptime for tables and details", () => {
    expect(formatUptimeTable(100)).toBe("100%")
    expect(formatUptimeTable(99.5)).toBe("99.5%")
    expect(formatUptimeDetail(100)).toBe("100%")
    expect(formatUptimeDetail(99.930_64)).toBe("99.9306%")
    expect(formatUptimeDetail(99.99)).toBe("99.99%")
    expect(formatUptimeDetail(98.123)).toBe("98.12%")
    expect(formatUptimeTable(null)).toBe("—")
  })

  it("formats latency and compact durations", () => {
    expect(formatLatency(141.7)).toBe("142 ms")
    expect(formatDuration(42)).toBe("42s")
    expect(formatDuration(1084)).toBe("18m 4s")
    expect(formatDuration(4320)).toBe("1h 12m")
    expect(formatDuration(187_200)).toBe("2d 4h")
  })

  it("formats relative and UTC times", () => {
    const now = new Date("2026-07-18T14:03:30.000Z")
    expect(formatRelativeTime(new Date("2026-07-18T14:03:18.000Z"), now)).toBe(
      "12s ago"
    )
    expect(formatRelativeTime(new Date("2026-07-18T13:45:00.000Z"), now)).toBe(
      "18m ago"
    )
    expect(formatRelativeTime(new Date("2026-07-17T14:03:00.000Z"), now)).toBe(
      "Jul 17, 14:03"
    )
  })

  it("formats absolute times in the requested time zone", () => {
    const now = new Date("2026-07-18T14:03:30.000Z")
    expect(
      formatRelativeTime(
        new Date("2026-07-18T05:00:00.000Z"),
        now,
        "Asia/Bangkok"
      )
    ).toBe("12:00")
    // 18:30 UTC on Jul 17 is already Jul 18 in Bangkok, so it counts as today there.
    expect(
      formatRelativeTime(
        new Date("2026-07-17T18:30:00.000Z"),
        now,
        "Asia/Bangkok"
      )
    ).toBe("01:30")
    expect(
      formatRelativeTime(
        new Date("2026-07-16T18:30:00.000Z"),
        now,
        "Asia/Bangkok"
      )
    ).toBe("Jul 17, 01:30")
  })

  it("formats calendar-relative days in UTC", () => {
    const now = new Date("2026-07-18T14:03:30.000Z")
    expect(formatRelativeDay(new Date("2026-07-18T02:00:00.000Z"), now)).toBe(
      "Today at 02:00"
    )
    expect(formatRelativeDay(new Date("2026-07-17T23:00:00.000Z"), now)).toBe(
      "Yesterday at 23:00"
    )
    expect(formatRelativeDay(new Date("2026-07-15T05:00:00.000Z"), now)).toBe(
      "Wednesday at 05:00"
    )
    // Exactly 7 calendar days is the first "Last week" day, exactly 14 is the
    // first day that falls back to the absolute date.
    expect(formatRelativeDay(new Date("2026-07-11T05:00:00.000Z"), now)).toBe(
      "Last week"
    )
    expect(formatRelativeDay(new Date("2026-07-10T05:00:00.000Z"), now)).toBe(
      "Last week"
    )
    expect(formatRelativeDay(new Date("2026-07-04T05:00:00.000Z"), now)).toBe(
      "Jul 4"
    )
    expect(formatRelativeDay(new Date("2026-06-28T05:00:00.000Z"), now)).toBe(
      "Jun 28"
    )
    expect(formatRelativeDay(new Date("2025-12-01T05:00:00.000Z"), now)).toBe(
      "Dec 1, 2025"
    )
  })

  it("compares calendar days in the viewer time zone, not UTC", () => {
    const now = new Date("2026-07-18T14:03:30.000Z")
    // 18:30 UTC on Jul 17 is Yesterday in UTC but already Jul 18 in Bangkok,
    // so it reads Today there while the same instant reads Yesterday in UTC.
    expect(formatRelativeDay(new Date("2026-07-17T18:30:00.000Z"), now)).toBe(
      "Yesterday at 18:30"
    )
    expect(
      formatRelativeDay(
        new Date("2026-07-17T18:30:00.000Z"),
        now,
        "Asia/Bangkok"
      )
    ).toBe("Today at 01:30")
    expect(
      formatRelativeDay(
        new Date("2026-07-17T05:00:00.000Z"),
        now,
        "Asia/Bangkok"
      )
    ).toBe("Yesterday at 12:00")
    expect(
      formatRelativeDay(
        new Date("2026-07-15T05:00:00.000Z"),
        now,
        "Asia/Bangkok"
      )
    ).toBe("Wednesday at 12:00")
  })

  it("formats a bucket time range in the viewer time zone", () => {
    const start = Date.parse("2026-07-20T07:30:00.000Z")
    const end = Date.parse("2026-07-20T07:45:00.000Z")
    expect(formatBucketTimeRange(start, end)).toBe("Jul 20, 07:30 to 07:45")
    expect(formatBucketTimeRange(start, end, "Asia/Bangkok")).toBe(
      "Jul 20, 14:30 to 14:45"
    )
  })

  it("formats a bucket range identically for a DST-free fixed offset and its DST-observing peer", () => {
    // 07:30-07:45 UTC is 14:30-14:45 at UTC+7. Etc/GMT-7 is a fixed +7 offset
    // with no daylight saving, so its output must match, proving the range is
    // a plain wall-clock projection and not a DST-sensitive calculation.
    const start = Date.parse("2026-07-20T07:30:00.000Z")
    const end = Date.parse("2026-07-20T07:45:00.000Z")
    expect(formatBucketTimeRange(start, end, "Etc/GMT-7")).toBe(
      "Jul 20, 14:30 to 14:45"
    )
    expect(formatBucketTimeRange(start, end, "Etc/GMT-7")).toBe(
      formatBucketTimeRange(start, end, "Asia/Bangkok")
    )
  })

  it("keeps midnight as 00:00 and carries both dates when a bucket crosses a day", () => {
    const start = Date.parse("2026-07-20T23:45:00.000Z")
    const end = Date.parse("2026-07-21T00:00:00.000Z")
    expect(formatBucketTimeRange(start, end)).toBe(
      "Jul 20 23:45 to Jul 21 00:00"
    )
    // In Bangkok both instants fall on Jul 21, so it collapses to one date.
    expect(formatBucketTimeRange(start, end, "Asia/Bangkok")).toBe(
      "Jul 21, 06:45 to 07:00"
    )
  })
})
