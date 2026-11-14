import type { LatencyPoint } from "@/components/charts/latency-chart"

const DAY_MS = 86_400_000

export interface LatencyChartLabels {
  // True when the series covers a full day or more, so ticks carry the date.
  spansDays: boolean
  tick: (timestamp: string) => string
  tooltip: (timestamp: string) => string
}

// Time labels for the latency chart in the viewer's zone. A series that
// covers a day or more repeats clock times, so its ticks read "Nov 12, 14:30".
// Shorter series keep "14:30" ticks. Tooltips always carry the date. The
// h23 cycle keeps midnight as "00:00", never "24:00".
export function latencyChartLabels(
  points: LatencyPoint[],
  timeZone: string
): LatencyChartLabels {
  const first = points.at(0)
  const last = points.at(-1)
  const spansDays =
    first !== undefined &&
    last !== undefined &&
    Date.parse(last.timestamp) - Date.parse(first.timestamp) >= DAY_MS

  const time = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  })
  const dateTime = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  })

  return {
    spansDays,
    tick: (timestamp) =>
      (spansDays ? dateTime : time).format(new Date(timestamp)),
    tooltip: (timestamp) => dateTime.format(new Date(timestamp)),
  }
}
