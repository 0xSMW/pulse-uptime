// Decimal places on uptime figures are a maximum, never padding. Trailing
// zeros carry no information and read as noise, so 100 renders as "100%"
// and 99.9900 as "99.99%", while 99.9306 keeps its full precision.
export function trimTrailingZeros(fixed: string): string {
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

export function formatUptimeTable(value: number | null): string {
  return value === null ? "—" : `${trimTrailingZeros(value.toFixed(2))}%`;
}

export function formatUptimeDetail(value: number | null): string {
  if (value === null) return "—";
  return `${trimTrailingZeros(value.toFixed(value > 99 ? 4 : 2))}%`;
}

export function formatLatency(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} ms`;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatRelativeTime(value: Date, now = new Date(), timeZone = "UTC"): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - value.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;

  const dayOf = (date: Date) =>
    date.toLocaleDateString("en-CA", { timeZone });
  if (dayOf(value) === dayOf(now)) {
    return value.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    });
  }
  return value.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  });
}
