import type { ReactNode } from "react"
import { isValidElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { LatencyPoint } from "@/components/charts/latency-chart"
import type { PlottedLatencyPoint } from "@/components/charts/latency-chart-data"

// Recharts needs a measured container, so the mock records the props the
// chart hands each piece and renders children inline.
const captured = vi.hoisted(() => ({
  props: {} as Record<string, Record<string, unknown>>,
}))

vi.mock("recharts", () => {
  const record =
    (name: string) =>
    (props: Record<string, unknown> & { children?: ReactNode }) => {
      captured.props[name] = props
      return props.children ?? null
    }
  return {
    Area: record("Area"),
    AreaChart: record("AreaChart"),
    CartesianGrid: record("CartesianGrid"),
    ResponsiveContainer: record("ResponsiveContainer"),
    Tooltip: record("Tooltip"),
    XAxis: record("XAxis"),
    YAxis: record("YAxis"),
  }
})

vi.mock("@/components/dashboard/timezone-provider", () => ({
  useTimezone: () => ({ resolvedTimeZone: "Asia/Bangkok" }),
}))

const { LatencyChart } = await import("@/components/charts/latency-chart")

const HOUR_MS = 3_600_000
const START = Date.parse("2026-10-14T00:00:00.000Z")
const END_30D = START + 720 * HOUR_MS

// A dense hourly series with a three day outage of samples and one failed
// bucket that still timed a response.
function hourlySeries(count: number): LatencyPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: new Date(START + index * HOUR_MS).toISOString(),
    latencyMs: index >= 300 && index < 372 ? null : 100 + (index % 50),
    successful: index !== 400,
  }))
}

function plottedData() {
  return captured.props.AreaChart?.data as PlottedLatencyPoint[]
}

beforeEach(() => {
  captured.props = {}
})

describe("LatencyChart", () => {
  it("plots every bucket on a time axis spanning the selected range", () => {
    renderToStaticMarkup(
      <LatencyChart data={hourlySeries(720)} endMs={END_30D} startMs={START} />
    )

    const plotted = plottedData()
    expect(plotted).toHaveLength(720)
    expect(plotted[0]?.time).toBe(START)
    expect(plotted.at(-1)?.time).toBe(END_30D - HOUR_MS)
    expect(plotted.slice(300, 372).every((p) => p.latencyMs === null)).toBe(
      true
    )
    expect(plotted[400]?.latencyMs).toBe(100)

    const xAxis = captured.props.XAxis as {
      dataKey: string
      domain: [number, number]
      type: string
      ticks: number[]
    }
    expect(xAxis.type).toBe("number")
    expect(xAxis.dataKey).toBe("time")
    expect(xAxis.domain).toEqual([START, END_30D])
    for (const tick of xAxis.ticks) {
      expect(tick).toBeGreaterThanOrEqual(START)
      expect(tick).toBeLessThanOrEqual(END_30D)
    }
    expect(captured.props.Area?.connectNulls).toBe(false)
    expect(captured.props.Area?.dataKey).toBe("latencyMs")
  })

  it("keeps empty time at the range edges instead of stretching samples", () => {
    // One day of samples in the middle of a 30 day range.
    const data = hourlySeries(720).slice(400, 424)
    renderToStaticMarkup(
      <LatencyChart data={data} endMs={END_30D} startMs={START} />
    )

    const xAxis = captured.props.XAxis as { domain: [number, number] }
    expect(xAxis.domain).toEqual([START, END_30D])
    expect(plottedData()[0]?.time).toBe(START + 400 * HOUR_MS)
  })

  it("labels multi-day ticks with dates and tooltips with zoned time", () => {
    renderToStaticMarkup(
      <LatencyChart data={hourlySeries(720)} endMs={END_30D} startMs={START} />
    )

    const xAxis = captured.props.XAxis as {
      tickFormatter: (value: number) => string
      ticks: number[]
    }
    const tooltip = captured.props.Tooltip as {
      filterNull: boolean
      formatter: (value: unknown, name: string) => [string, string]
      labelFormatter: (label: unknown) => unknown
    }

    expect(xAxis.tickFormatter(xAxis.ticks[0]!)).toBe("Oct 15")
    expect(tooltip.labelFormatter(END_30D - HOUR_MS)).toBe("Nov 13, 06:00")
    expect(tooltip.filterNull).toBe(false)
    expect(tooltip.formatter(123.4, "latencyMs")).toEqual(["123 ms", "Latency"])
    expect(tooltip.formatter(null, "latencyMs")).toEqual(["No data", "Latency"])
  })

  it("keeps time-only ticks for a 24 hour range", () => {
    renderToStaticMarkup(
      <LatencyChart
        data={hourlySeries(24)}
        endMs={START + 24 * HOUR_MS}
        startMs={START}
      />
    )

    const xAxis = captured.props.XAxis as {
      tickFormatter: (value: number) => string
      ticks: number[]
    }
    expect(xAxis.ticks.map((tick) => xAxis.tickFormatter(tick))).toEqual([
      "08:00",
      "12:00",
      "16:00",
      "20:00",
      "00:00",
      "04:00",
    ])
  })

  it("dots a lone sample between gaps so it stays visible", () => {
    const data: LatencyPoint[] = [
      {
        timestamp: new Date(START).toISOString(),
        latencyMs: null,
        successful: false,
      },
      {
        timestamp: new Date(START + HOUR_MS).toISOString(),
        latencyMs: 210,
        successful: false,
      },
      {
        timestamp: new Date(START + 2 * HOUR_MS).toISOString(),
        latencyMs: null,
        successful: false,
      },
    ]
    renderToStaticMarkup(
      <LatencyChart data={data} endMs={START + 24 * HOUR_MS} startMs={START} />
    )

    const dot = captured.props.Area?.dot as (props: {
      cx?: number
      cy?: number
      payload: PlottedLatencyPoint
    }) => ReactNode
    const plotted = plottedData()
    expect(isValidElement(dot({ cx: 10, cy: 20, payload: plotted[1]! }))).toBe(
      true
    )
    expect(dot({ cx: 10, cy: 20, payload: plotted[0]! })).toBeNull()
  })
})
