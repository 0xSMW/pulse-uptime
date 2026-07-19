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

export function formatIncidentTimeOfDay(value: string, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
    timeZoneName: "short",
  }).format(new Date(value));
}

// Same calendar day in the DISPLAY timezone, not UTC. Two instants can share
// a UTC date yet fall on different local days, and vice versa.
export function sameDayInZone(a: string, b: string, timeZone = "UTC"): boolean {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return day.format(new Date(a)) === day.format(new Date(b));
}

export function formatIncidentDuration(seconds: number): string {
  return formatDuration(Math.max(0, seconds));
}
