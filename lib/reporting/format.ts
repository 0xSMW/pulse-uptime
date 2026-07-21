// Decimal places on uptime figures are a maximum, never padding. Trailing
// zeros carry no information and read as noise, so 100 renders as "100%"
// and 99.9900 as "99.99%", while 99.9306 keeps its full precision.
export function trimTrailingZeros(fixed: string): string {
  return fixed.includes(".")
    ? fixed.replace(/0+$/, "").replace(/\.$/, "")
    : fixed
}

export function formatUptimeTable(value: number | null): string {
  return value === null ? "—" : `${trimTrailingZeros(value.toFixed(2))}%`
}

export function formatUptimeDetail(value: number | null): string {
  if (value === null) {
    return "—"
  }
  return `${trimTrailingZeros(value.toFixed(value > 99 ? 4 : 2))}%`
}

export function formatLatency(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} ms`
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`
  }
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

// Human date and time range for a timeline bucket, rendered in the viewer's
// zone, e.g. "Jul 20, 14:30 to 15:15". Buckets whose start and end fall on
// different calendar days in the viewer zone carry both dates. hourCycle h23
// keeps midnight as 00:00 rather than 24:00.
export function formatBucketTimeRange(
  startMs: number,
  endMs: number,
  timeZone = "UTC"
): string {
  const start = new Date(startMs)
  const end = new Date(endMs)
  const dateOf = (value: Date) =>
    value.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone,
    })
  const timeOf = (value: Date) =>
    value.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    })
  if (dateOf(start) === dateOf(end)) {
    return `${dateOf(start)}, ${timeOf(start)} to ${timeOf(end)}`
  }
  return `${dateOf(start)} ${timeOf(start)} to ${dateOf(end)} ${timeOf(end)}`
}

// Calendar day count of value in the given zone, expressed as whole days since
// the Unix epoch. en-CA renders the wall-clock date as YYYY-MM-DD in the zone,
// so a check at 23:50 Bangkok time and one at 00:10 the next Bangkok morning
// land on different day numbers even though they are twenty minutes apart in
// UTC. The projected parts build a UTC midnight, so the difference between two
// day numbers is a plain calendar-day count immune to daylight saving.
function zonedDayNumber(value: Date, timeZone: string): number {
  const [year, month, day] = value
    .toLocaleDateString("en-CA", { timeZone })
    .split("-")
  return Math.floor(
    Date.UTC(Number(year), Number(month) - 1, Number(day)) / 86_400_000
  )
}

// Human, calendar-relative label for the recent incidents and checks tables.
// Calendar days are compared in the viewer zone, never in UTC, so the boundary
// is the viewer's midnight. Same day reads "Today at HH:MM", the prior day
// "Yesterday at HH:MM", the rest of the past week the weekday with its time,
// the week before that "Last week", and anything older the absolute date with
// the year only when it differs from now.
export function formatRelativeDay(
  value: Date,
  now = new Date(),
  timeZone = "UTC"
): string {
  const time = value.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  })
  const days = zonedDayNumber(now, timeZone) - zonedDayNumber(value, timeZone)
  if (days <= 0) {
    return `Today at ${time}`
  }
  if (days === 1) {
    return `Yesterday at ${time}`
  }
  if (days < 7) {
    const weekday = value.toLocaleDateString("en-US", {
      weekday: "long",
      timeZone,
    })
    return `${weekday} at ${time}`
  }
  if (days < 14) {
    return "Last week"
  }
  const sameYear =
    value.toLocaleDateString("en-US", { year: "numeric", timeZone }) ===
    now.toLocaleDateString("en-US", { year: "numeric", timeZone })
  return value.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    timeZone,
  })
}

export function formatRelativeTime(
  value: Date,
  now = new Date(),
  timeZone = "UTC"
): string {
  const seconds = Math.max(
    0,
    Math.floor((now.getTime() - value.getTime()) / 1000)
  )
  if (seconds < 60) {
    return `${seconds}s ago`
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`
  }

  const dayOf = (date: Date) => date.toLocaleDateString("en-CA", { timeZone })
  if (dayOf(value) === dayOf(now)) {
    return value.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    })
  }
  return value.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  })
}
