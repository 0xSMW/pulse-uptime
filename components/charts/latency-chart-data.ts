import type { LatencyPoint } from "@/components/charts/latency-chart"

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export interface PlottedLatencyPoint {
  time: number
  timestamp: string
  latencyMs: number | null
  // True for a sample with no sampled neighbor, which draws no line segment,
  // so the chart marks it with a dot instead.
  isolated: boolean
}

// Places each point on a numeric time axis. When two consecutive samples sit
// further apart than the series step, a null point goes between them, so the
// line breaks across unobserved time instead of bridging it. Values are never
// invented.
export function plotLatencyPoints(
  points: LatencyPoint[]
): PlottedLatencyPoint[] {
  const times = points.map((point) => Date.parse(point.timestamp))
  let stepMs = Number.POSITIVE_INFINITY
  for (let index = 1; index < times.length; index += 1) {
    const diff = times[index]! - times[index - 1]!
    if (diff > 0 && diff < stepMs) {
      stepMs = diff
    }
  }

  const plotted: Omit<PlottedLatencyPoint, "isolated">[] = []
  points.forEach((point, index) => {
    const time = times[index]!
    const previous = plotted.at(-1)
    if (
      previous &&
      previous.latencyMs !== null &&
      point.latencyMs !== null &&
      time - previous.time > stepMs
    ) {
      const gapTime = previous.time + stepMs
      plotted.push({
        time: gapTime,
        timestamp: new Date(gapTime).toISOString(),
        latencyMs: null,
      })
    }
    plotted.push({
      time,
      timestamp: point.timestamp,
      latencyMs: point.latencyMs,
    })
  })

  return plotted.map((point, index) => ({
    ...point,
    isolated:
      point.latencyMs !== null &&
      (plotted[index - 1]?.latencyMs ?? null) === null &&
      (plotted[index + 1]?.latencyMs ?? null) === null,
  }))
}

export interface LatencyChartLabels {
  // True when the range covers more than a day, so ticks name dates.
  spansDays: boolean
  ticks: number[]
  tick: (time: number) => string
  tooltip: (time: number) => string
}

// Time labels for the latency chart in the viewer's zone. Ranges over a day
// tick at local midnights and read "Nov 12". Shorter ranges tick on local
// hours and read "14:00". Tooltips always carry the date. The h23 cycle keeps
// midnight as "00:00", never "24:00". Short labels fit inside the chart's
// right margin, so a tick on the range end never clips.
export function latencyChartLabels(
  startMs: number,
  endMs: number,
  timeZone: string
): LatencyChartLabels {
  const spanMs = endMs - startMs
  const spansDays = spanMs > DAY_MS

  const clock = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  })
  const date = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
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

  let alignMinutes: number
  let advanceMs: number
  if (spansDays) {
    const everyDays = Math.max(1, Math.ceil(spanMs / DAY_MS / 7))
    alignMinutes = 1440
    advanceMs = everyDays * DAY_MS
  } else {
    let everyHours = 4
    if (spanMs <= 6 * HOUR_MS) {
      everyHours = 1
    } else if (spanMs <= 12 * HOUR_MS) {
      everyHours = 2
    }
    alignMinutes = everyHours * 60
    advanceMs = everyHours * HOUR_MS
  }

  return {
    spansDays,
    ticks: zonedTicks(startMs, endMs, clock, alignMinutes, advanceMs),
    tick: (time) => (spansDays ? date : clock).format(time),
    tooltip: (time) => dateTime.format(time),
  }
}

function localMinuteOfDay(time: number, clock: Intl.DateTimeFormat): number {
  let hour = 0
  let minute = 0
  for (const part of clock.formatToParts(time)) {
    if (part.type === "hour") {
      hour = Number(part.value)
    } else if (part.type === "minute") {
      minute = Number(part.value)
    }
  }
  return hour * 60 + minute
}

// Ticks on local wall-clock boundaries in [startMs, endMs]. Each candidate
// snaps to the nearest boundary, so a DST shift keeps ticks on the hour or
// midnight the label names. A snap moves at most half a step, so the loop
// always advances.
function zonedTicks(
  startMs: number,
  endMs: number,
  clock: Intl.DateTimeFormat,
  alignMinutes: number,
  advanceMs: number
): number[] {
  const snap = (time: number) => {
    const offset = localMinuteOfDay(time, clock) % alignMinutes
    if (offset === 0) {
      return time
    }
    return offset <= alignMinutes / 2
      ? time - offset * MINUTE_MS
      : time + (alignMinutes - offset) * MINUTE_MS
  }

  const base = Math.ceil(startMs / MINUTE_MS) * MINUTE_MS
  const lead = localMinuteOfDay(base, clock) % alignMinutes
  let tick = snap(base + ((alignMinutes - lead) % alignMinutes) * MINUTE_MS)
  const ticks: number[] = []
  while (tick <= endMs) {
    if (tick >= startMs) {
      ticks.push(tick)
    }
    tick = snap(tick + advanceMs)
  }
  return ticks
}
