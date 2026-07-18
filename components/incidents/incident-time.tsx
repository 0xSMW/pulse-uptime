"use client";

import { useTimezone } from "@/components/dashboard/timezone-provider";
import { formatIncidentTime } from "@/components/incidents/incident-format";

export function IncidentTime({ value }: { value: string }) {
  const { resolvedTimeZone } = useTimezone();
  return <>{formatIncidentTime(value, resolvedTimeZone)}</>;
}
