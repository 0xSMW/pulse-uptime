import { describe, expect, it } from "vitest"

import type { LatencyPoint } from "@/components/charts/latency-chart"
import {
  latencyChartLabels,
  plotLatencyPoints,
} from "@/components/charts/latency-chart-data"

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

function point(timestamp: string, latencyMs: number | null): LatencyPoint {
  return { timestamp, latencyMs, successful: latencyMs !== null }
}

const iso = (ms: number) => new Date(ms).toISOString()

describe("latencyChartLabels", () => {
  it("ticks a 24 hour range on local 4 hour boundaries with time labels", () => {
    const start = Date.parse("2026-10-14T00:00:00.000Z")
    const labels = latencyChartLabels(start, start + DAY_MS, "Asia/Bangkok")

    expect(labels.spansDays).toBe(false)
    // 00:00Z is 07:00 in Bangkok, so the first boundary is 08:00 local.
    expect(labels.ticks.map((tick) => labels.tick(tick))).toEqual([
      "08:00",
      "12:00",
      "16:00",
      "20:00",
      "00:00",
      "04:00",
    ])
    expect(labels.ticks[0]).toBe(Date.parse("2026-10-14T01:00:00.000Z"))
    expect(labels.tooltip(start + DAY_MS - 900_000)).toBe("Oct 15, 06:45")
  })

  it("ticks a 30 day range at local midnights with date labels", () => {
    const end = Date.parse("2026-11-13T00:00:00.000Z")
    const start = end - 30 * DAY_MS
    const bangkok = latencyChartLabels(start, end, "Asia/Bangkok")

    expect(bangkok.spansDays).toBe(true)
    expect(bangkok.ticks.length).toBeGreaterThanOrEqual(5)
    expect(bangkok.ticks.length).toBeLessThanOrEqual(7)
    for (const tick of bangkok.ticks) {
      expect(tick).toBeGreaterThanOrEqual(start)
      expect(tick).toBeLessThanOrEqual(end)
      // Bangkok midnight is 17:00Z.
      expect(new Date(tick).getUTCHours()).toBe(17)
    }
    expect(bangkok.tick(bangkok.ticks[0]!)).toBe("Oct 15")
    expect(bangkok.tooltip(start)).toBe("Oct 14, 07:00")

    const newYork = latencyChartLabels(start, end, "America/New_York")
    expect(newYork.tick(newYork.ticks[0]!)).toBe("Oct 14")
  })

  it("keeps ticks on local midnight across a DST change", () => {
    const start = Date.parse("2026-10-29T12:00:00.000Z")
    const labels = latencyChartLabels(
      start,
      start + 7 * DAY_MS,
      "America/New_York"
    )

    // New York leaves daylight time on Nov 1, 2026.
    expect(labels.ticks.map((tick) => labels.tick(tick))).toEqual([
      "Oct 30",
      "Oct 31",
      "Nov 1",
      "Nov 2",
      "Nov 3",
      "Nov 4",
      "Nov 5",
    ])
    for (const tick of labels.ticks) {
      expect(labels.tooltip(tick)).toMatch(/, 00:00$/)
    }
  })

  it("keeps every tick label short enough for the right margin", () => {
    const end = Date.parse("2026-12-31T12:00:00.000Z")
    for (const span of [DAY_MS, 7 * DAY_MS, 30 * DAY_MS]) {
      const labels = latencyChartLabels(end - span, end, "UTC")
      for (const tick of labels.ticks) {
        expect(labels.tick(tick).length).toBeLessThanOrEqual(6)
      }
    }
  })

  it("renders local midnight as 00:00 on the new day", () => {
    const start = Date.parse("2026-10-14T12:00:00.000Z")
    const labels = latencyChartLabels(start, start + DAY_MS, "Asia/Bangkok")

    expect(labels.tooltip(Date.parse("2026-10-14T17:00:00.000Z"))).toBe(
      "Oct 15, 00:00"
    )
    expect(labels.tick(Date.parse("2026-10-14T17:00:00.000Z"))).toBe("00:00")
  })
})

describe("plotLatencyPoints", () => {
  const start = Date.parse("2026-10-14T00:00:00.000Z")

  it("places points on epoch time and keeps every sample and gap", () => {
    const plotted = plotLatencyPoints([
      point(iso(start), 120),
      point(iso(start + HOUR_MS), null),
      point(iso(start + 2 * HOUR_MS), 140),
      point(iso(start + 3 * HOUR_MS), 150),
    ])

    expect(plotted.map((entry) => [entry.time, entry.latencyMs])).toEqual([
      [start, 120],
      [start + HOUR_MS, null],
      [start + 2 * HOUR_MS, 140],
      [start + 3 * HOUR_MS, 150],
    ])
    expect(plotted.map((entry) => entry.isolated)).toEqual([
      true,
      false,
      false,
      false,
    ])
  })

  it("breaks the line where samples skip unobserved buckets", () => {
    const plotted = plotLatencyPoints([
      point(iso(start), 120),
      point(iso(start + HOUR_MS), 130),
      point(iso(start + 5 * HOUR_MS), 140),
      point(iso(start + 6 * HOUR_MS), 150),
    ])

    expect(plotted.map((entry) => [entry.time, entry.latencyMs])).toEqual([
      [start, 120],
      [start + HOUR_MS, 130],
      [start + 2 * HOUR_MS, null],
      [start + 5 * HOUR_MS, 140],
      [start + 6 * HOUR_MS, 150],
    ])
    expect(plotted.some((entry) => entry.isolated)).toBe(false)
  })
})
