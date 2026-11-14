import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { LatencyPoint } from "@/components/charts/latency-chart"

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

function hourlySeries(count: number): LatencyPoint[] {
  const start = Date.parse("2026-10-14T00:00:00.000Z")
  return Array.from({ length: count }, (_, index) => ({
    timestamp: new Date(start + index * 3_600_000).toISOString(),
    latencyMs: index === 300 ? null : 100 + (index % 50),
    successful: index !== 300,
  }))
}

beforeEach(() => {
  captured.props = {}
})

describe("LatencyChart", () => {
  it("draws every point of a 30 day range with its endpoints intact", () => {
    const data = hourlySeries(720)
    renderToStaticMarkup(<LatencyChart data={data} />)

    const plotted = captured.props.AreaChart?.data as LatencyPoint[]
    expect(plotted).toHaveLength(720)
    expect(plotted[0]?.timestamp).toBe("2026-10-14T00:00:00.000Z")
    expect(plotted.at(-1)?.timestamp).toBe("2026-11-12T23:00:00.000Z")
    expect(plotted[300]?.latencyMs).toBeNull()
    expect(captured.props.Area?.connectNulls).toBe(false)
    expect(captured.props.Area?.dataKey).toBe("latencyMs")
  })

  it("labels multi-day ticks and tooltips with date and zoned time", () => {
    renderToStaticMarkup(<LatencyChart data={hourlySeries(720)} />)

    const xAxis = captured.props.XAxis as {
      dataKey: string
      tickFormatter: (value: string) => string
    }
    const tooltip = captured.props.Tooltip as {
      labelFormatter: (label: unknown) => unknown
    }

    expect(xAxis.dataKey).toBe("timestamp")
    expect(xAxis.tickFormatter("2026-10-14T00:00:00.000Z")).toBe(
      "Oct 14, 07:00"
    )
    expect(xAxis.tickFormatter("2026-11-12T23:00:00.000Z")).toBe(
      "Nov 13, 06:00"
    )
    expect(tooltip.labelFormatter("2026-11-12T23:00:00.000Z")).toBe(
      "Nov 13, 06:00"
    )
  })

  it("keeps time-only ticks for a 24 hour range", () => {
    renderToStaticMarkup(<LatencyChart data={hourlySeries(24)} />)

    const xAxis = captured.props.XAxis as {
      tickFormatter: (value: string) => string
    }
    expect(xAxis.tickFormatter("2026-10-14T23:00:00.000Z")).toBe("06:00")
  })
})
