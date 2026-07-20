"use client";

import { useTimezone } from "@/components/dashboard/timezone-provider";
import { formatRelativeTime } from "@/lib/reporting/format";

// Small client leaf so the Dependencies panel and detail page (both server
// components) can render a timezone-aware relative timestamp, matching the
// IncidentTime convention in components/incidents/incident-time.tsx.
//
// While pending is true no poll has landed yet, so the cell reads "Awaiting
// first check" rather than "Never". "Never" is reserved for a dependency that
// has been polled successfully but whose provider reported no update time.
export function DependencyUpdatedTime({ value, pending = false }: { value: string | null; pending?: boolean }) {
  const { resolvedTimeZone } = useTimezone();
  if (pending) return <>Awaiting first check</>;
  if (!value) return <>Never</>;
  return <>{formatRelativeTime(new Date(value), new Date(), resolvedTimeZone)}</>;
}
