"use client"

import { useTimezone } from "@/components/dashboard/timezone-provider"
import {
  formatIncidentTime,
  formatIncidentTimeOfDay,
} from "@/components/incidents/incident-format"
import { sameDayInZone } from "@/lib/reporting/format"

// When `sameDayOf` is provided and both instants fall on the same calendar
// day in the display timezone, the date is dropped and only the time shows.
// A resolved-at next to its started-at should not repeat the date.
export function IncidentTime({
  value,
  sameDayOf,
}: {
  value: string
  sameDayOf?: string
}) {
  const { resolvedTimeZone } = useTimezone()
  if (sameDayOf && sameDayInZone(value, sameDayOf, resolvedTimeZone)) {
    return <>{formatIncidentTimeOfDay(value, resolvedTimeZone)}</>
  }
  return <>{formatIncidentTime(value, resolvedTimeZone)}</>
}
