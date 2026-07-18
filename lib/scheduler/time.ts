import { MONITOR_INTERVALS, type MonitorConfig } from "@/lib/config/schema";

const MINUTE_MS = 60_000;

export function scheduledMinuteAt(now: Date): Date {
  return new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS);
}

export function isDueAt(monitor: Pick<MonitorConfig, "enabled" | "intervalMinutes">, scheduledAt: Date): boolean {
  if (!monitor.enabled || !MONITOR_INTERVALS.includes(monitor.intervalMinutes)) return false;
  const minute = Math.floor(scheduledAt.getTime() / MINUTE_MS);
  return minute % monitor.intervalMinutes === 0;
}

export function utcDay(value: Date, daysAgo = 0): string {
  const date = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() - daysAgo));
  return date.toISOString().slice(0, 10);
}
