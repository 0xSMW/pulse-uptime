"use client"

import { useTimezone } from "@/components/dashboard/timezone-provider"
import {
  formatIncidentRangeParts,
  formatIncidentTimeOfDay,
  formatIncidentTimeParts,
} from "@/components/incidents/incident-format"
import { sameDayInZone } from "@/lib/reporting/format"

// When `sameDayOf` is provided and both instants fall on the same calendar
// day in the display timezone, the date is dropped and only the time shows.
// A resolved-at next to its started-at should not repeat the date.
//
// The date and the time with zone each stay on one line. A narrow cell wraps
// only between them, so the zone never sits alone on a line.
export function IncidentTime({
  value,
  sameDayOf,
}: {
  value: string
  sameDayOf?: string
}) {
  const { resolvedTimeZone } = useTimezone()
  if (sameDayOf && sameDayInZone(value, sameDayOf, resolvedTimeZone)) {
    return (
      <time className="whitespace-nowrap" dateTime={value}>
        {formatIncidentTimeOfDay(value, resolvedTimeZone)}
      </time>
    )
  }
  const { date, separator, time } = formatIncidentTimeParts(
    value,
    resolvedTimeZone
  )
  return (
    <time dateTime={value}>
      <span className="whitespace-nowrap">{date}</span>
      {separator}
      <span className="whitespace-nowrap">{time}</span>
    </time>
  )
}

export function IncidentTimeRange({
  startAt,
  endAt,
}: {
  startAt: string
  endAt: string
}) {
  const { resolvedTimeZone } = useTimezone()
  const { startDate, startTime, endDate, endTime } = formatIncidentRangeParts(
    startAt,
    endAt,
    resolvedTimeZone
  )
  // Each date and each time with zone stays on one line. The range wraps
  // only at the comma space or after the dash, so a zone never sits alone.
  return (
    <>
      <span className="whitespace-nowrap">{startDate}</span>
      {", "}
      <span className="whitespace-nowrap">{startTime}</span>
      {"–"}
      {endDate === null ? null : (
        <>
          <span className="whitespace-nowrap">{endDate}</span>
          {", "}
        </>
      )}
      <span className="whitespace-nowrap">{endTime}</span>
    </>
  )
}
