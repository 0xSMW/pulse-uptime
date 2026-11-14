"use client"

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import { latencyChartLabels } from "@/components/charts/latency-chart-data"
import { useTimezone } from "@/components/dashboard/timezone-provider"
import { formatLatency } from "@/lib/reporting/format"

export interface LatencyPoint {
  timestamp: string
  latencyMs: number | null
  successful: boolean
}

// Human labels for the series a tooltip can carry. The raw data key is never
// shown. An unmapped key falls back to itself so a new series stays legible.
const seriesLabels: Record<string, string> = {
  latencyMs: "Latency",
}

// The chart draws every point in the selected range. Ranges top out near 720
// rollup buckets, which Recharts renders without downsampling.
export function LatencyChart({ data }: { data: LatencyPoint[] }) {
  const { resolvedTimeZone } = useTimezone()
  const labels = latencyChartLabels(data, resolvedTimeZone)

  return (
    <div
      aria-label="Response time chart"
      className="h-[220px] w-full"
      role="img"
    >
      <ResponsiveContainer height="100%" width="100%">
        <AreaChart
          data={data}
          margin={{
            top: 8,
            right: labels.spansDays ? 72 : 24,
            bottom: 0,
            left: 4,
          }}
        >
          <defs>
            <linearGradient id="latency-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--fg)" stopOpacity={0.08} />
              <stop offset="100%" stopColor="var(--fg)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis
            axisLine={false}
            dataKey="timestamp"
            minTickGap={48}
            tick={{
              fill: "var(--fg-muted)",
              fontFamily: "var(--font-geist-mono)",
              fontSize: 11,
            }}
            tickFormatter={(value: string) => labels.tick(value)}
            tickLine={false}
          />
          <YAxis
            axisLine={false}
            tick={{
              fill: "var(--fg-muted)",
              fontFamily: "var(--font-geist-mono)",
              fontSize: 11,
            }}
            tickFormatter={(value) => `${value} ms`}
            tickLine={false}
            width={44}
          />
          <Tooltip
            contentStyle={{
              background: "var(--bg)",
              border: "1px solid var(--border-strong)",
              borderRadius: 6,
              boxShadow: "var(--popover-shadow)",
              fontFamily: "var(--font-geist-mono)",
              fontSize: 11,
            }}
            formatter={(value, name) => [
              formatLatency(typeof value === "number" ? value : null),
              seriesLabels[name as string] ?? name,
            ]}
            labelFormatter={(label) =>
              typeof label === "string" ? labels.tooltip(label) : label
            }
            separator="  "
          />
          <Area
            connectNulls={false}
            dataKey="latencyMs"
            fill="url(#latency-fill)"
            isAnimationActive={false}
            stroke="var(--fg)"
            strokeWidth={1.5}
            type="monotone"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
