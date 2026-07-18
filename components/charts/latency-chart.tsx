"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type LatencyPoint = {
  timestamp: string;
  latencyMs: number | null;
  successful: boolean;
};

export function LatencyChart({ data }: { data: LatencyPoint[] }) {
  const points = data.slice(-240).map((point) => ({
    ...point,
    time: new Date(point.timestamp).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    }),
  }));

  return (
    <div className="h-[220px] w-full" aria-label="Response time chart">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
          <defs>
            <linearGradient id="latency-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--fg)" stopOpacity={0.08} />
              <stop offset="100%" stopColor="var(--fg)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="time"
            axisLine={false}
            tickLine={false}
            minTickGap={48}
            tick={{ fill: "var(--fg-muted)", fontFamily: "var(--font-geist-mono)", fontSize: 11 }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            width={44}
            tickFormatter={(value) => `${value} ms`}
            tick={{ fill: "var(--fg-muted)", fontFamily: "var(--font-geist-mono)", fontSize: 11 }}
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
          />
          <Area
            dataKey="latencyMs"
            type="monotone"
            stroke="var(--fg)"
            strokeWidth={1.5}
            fill="url(#latency-fill)"
            connectNulls={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
