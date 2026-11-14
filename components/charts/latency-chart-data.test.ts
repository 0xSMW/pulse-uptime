import { describe, expect, it } from "vitest"

import type { LatencyPoint } from "@/components/charts/latency-chart"
import { latencyChartLabels } from "@/components/charts/latency-chart-data"

function series(startIso: string, count: number, stepMs: number) {
  const start = Date.parse(startIso)
  return Array.from(
    { length: count },
    (_, index): LatencyPoint => ({
      timestamp: new Date(start + index * stepMs).toISOString(),
      latencyMs: 100 + index,
      successful: true,
    })
  )
}

describe("latencyChartLabels", () => {
  it("keeps time-only ticks under a day and dates every tooltip", () => {
    const points = series("2026-10-14T00:00:00.000Z", 96, 900_000)
    const labels = latencyChartLabels(points, "Asia/Bangkok")

    expect(labels.spansDays).toBe(false)
    expect(labels.tick(points[0]!.timestamp)).toBe("07:00")
    expect(labels.tick(points.at(-1)!.timestamp)).toBe("06:45")
    expect(labels.tooltip(points.at(-1)!.timestamp)).toBe("Oct 15, 06:45")
  })

  it("dates ticks across a 30 day range in the selected zone", () => {
    const points = series("2026-10-14T00:00:00.000Z", 720, 3_600_000)
    const bangkok = latencyChartLabels(points, "Asia/Bangkok")

    expect(bangkok.spansDays).toBe(true)
    expect(bangkok.tick(points[0]!.timestamp)).toBe("Oct 14, 07:00")
    expect(bangkok.tick(points.at(-1)!.timestamp)).toBe("Nov 13, 06:00")
    expect(bangkok.tooltip(points[0]!.timestamp)).toBe("Oct 14, 07:00")

    const newYork = latencyChartLabels(points, "America/New_York")
    expect(newYork.tick(points[0]!.timestamp)).toBe("Oct 13, 20:00")
    expect(newYork.tick(points.at(-1)!.timestamp)).toBe("Nov 12, 18:00")
  })

  it("dates ticks across a 7 day range of 15 minute buckets", () => {
    const points = series("2026-11-06T00:00:00.000Z", 672, 900_000)
    const labels = latencyChartLabels(points, "UTC")

    expect(labels.spansDays).toBe(true)
    expect(labels.tick(points[0]!.timestamp)).toBe("Nov 6, 00:00")
    expect(labels.tick(points.at(-1)!.timestamp)).toBe("Nov 12, 23:45")
  })

  it("renders local midnight as 00:00 on the new day", () => {
    const labels = latencyChartLabels([], "Asia/Bangkok")

    expect(labels.spansDays).toBe(false)
    expect(labels.tooltip("2026-10-14T17:00:00.000Z")).toBe("Oct 15, 00:00")
    expect(labels.tick("2026-10-14T17:00:00.000Z")).toBe("00:00")
  })
})
