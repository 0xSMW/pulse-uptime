import { formatDuration } from "@/lib/reporting/format";

export function formatIncidentTime(value: string, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
    timeZoneName: "short",
  }).format(new Date(value));
}

export function formatIncidentDuration(seconds: number): string {
  return formatDuration(Math.max(0, seconds));
}
