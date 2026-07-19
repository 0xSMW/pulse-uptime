"use client";

import { useTimezone } from "@/components/dashboard/timezone-provider";
import { formatRelativeTime } from "@/lib/reporting/format";

// Small client leaf so the Dependencies panel and detail page (both server
// components) can render a timezone-aware relative timestamp, matching the
// IncidentTime convention in components/incidents/incident-time.tsx.
export function DependencyUpdatedTime({ value }: { value: string | null }) {
  const { resolvedTimeZone } = useTimezone();
  if (!value) return <>Never</>;
  return <>{formatRelativeTime(new Date(value), new Date(), resolvedTimeZone)}</>;
}
