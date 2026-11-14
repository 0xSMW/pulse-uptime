import { formatDuration, sameDayInZone } from "@/lib/reporting/format"

function incidentTimeFormat(timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
    timeZoneName: "short",
  })
}

export function formatIncidentTime(value: string, timeZone = "UTC"): string {
  return incidentTimeFormat(timeZone).format(new Date(value))
}

const TIME_PART_TYPES = new Set<Intl.DateTimeFormatPartTypes>([
  "hour",
  "minute",
  "dayPeriod",
  "timeZoneName",
])

// Split the full timestamp into its date and its time with zone, so a
// wrapping layout can keep the time and zone on one line. The three pieces
// join back into exactly what formatIncidentTime returns.
export function formatIncidentTimeParts(
  value: string,
  timeZone = "UTC"
): { date: string; separator: string; time: string } {
  const parts = incidentTimeFormat(timeZone).formatToParts(new Date(value))
  let timeStart = parts.findIndex((part) => TIME_PART_TYPES.has(part.type))
  if (timeStart === -1) {
    timeStart = parts.length
  }
  let dateEnd = timeStart
  while (dateEnd > 0 && parts[dateEnd - 1]?.type === "literal") {
    dateEnd -= 1
  }
  const join = (from: number, to: number) =>
    parts
      .slice(from, to)
      .map((part) => part.value)
      .join("")
  return {
    date: join(0, dateEnd),
    separator: join(dateEnd, timeStart),
    time: join(timeStart, parts.length),
  }
}

export function formatIncidentTimeOfDay(
  value: string,
  timeZone = "UTC"
): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
    timeZoneName: "short",
  }).format(new Date(value))
}

export function formatIncidentDuration(seconds: number): string {
  return formatDuration(Math.max(0, seconds))
}

// Share the date and zone within a range, while preserving both zone labels
// across a daylight-saving transition and both years across a year boundary.
export function formatIncidentRange(
  startAt: string,
  endAt: string,
  timeZone = "UTC"
): string {
  const start = new Date(startAt)
  const end = new Date(endAt)
  const yearFormat = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    timeZone,
  })
  const differentYears = yearFormat.format(start) !== yearFormat.format(end)
  const dateFormat = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(differentYears ? { year: "numeric" as const } : {}),
    timeZone,
  })
  const timeFormat = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  })
  const zoneFormat = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  })
  const zoneOf = (value: Date) =>
    zoneFormat
      .formatToParts(value)
      .find((part) => part.type === "timeZoneName")!.value
  const startZone = zoneOf(start)
  const endZone = zoneOf(end)
  const first = `${dateFormat.format(start)}, ${timeFormat.format(start)}${startZone === endZone ? "" : ` ${startZone}`}`
  const last = `${sameDayInZone(start, end, timeZone) ? "" : `${dateFormat.format(end)}, `}${timeFormat.format(end)} ${endZone}`
  return `${first}–${last}`
}
