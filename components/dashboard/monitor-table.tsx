"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { StatusDot, type MonitorState } from "@/components/monitors/status-dot";
import { Input } from "@/components/ui/input";
import { formatLatency, formatRelativeTime, formatUptimeTable } from "@/lib/reporting/format";
import { cn } from "@/lib/utils";

export type DashboardMonitor = {
  id: string;
  name: string;
  url: string;
  state: MonitorState;
  uptime24h: number | null;
  lastLatencyMs: number | null;
  lastCheckedAt: string | null;
  activeIncidentOpenedAt: string | null;
};

const rowInteractiveSelector = "a, button, input, select, textarea, summary, [role='button'], [role='link'], [contenteditable='true']";

export function navigateFromMonitorRow(
  target: EventTarget | null,
  monitorId: string,
  navigate: (href: string) => void,
): boolean {
  const closest = (target as { closest?: (selector: string) => Element | null } | null)?.closest;
  if (typeof closest === "function" && closest.call(target, rowInteractiveSelector)) return false;
  navigate(`/monitors/${encodeURIComponent(monitorId)}`);
  return true;
}

function stateLabel(state: MonitorState): string {
  return state
    .toLowerCase()
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function MonitorTable({ monitors }: { monitors: DashboardMonitor[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return monitors;
    return monitors.filter((monitor) =>
      `${monitor.name}\n${monitor.url}`.toLowerCase().includes(needle),
    );
  }, [monitors, query]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  return (
    <div>
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--fg-muted)]" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search monitors"
          aria-label="Search monitors"
          className="pl-9 pr-10"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setQuery("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            ×
          </button>
        ) : (
          <kbd className="absolute right-3 top-1/2 -translate-y-1/2 rounded border border-[var(--border-strong)] px-1.5 font-data text-[10px] text-[var(--fg-muted)]">
            /
          </kbd>
        )}
      </div>
      <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
        <table className="w-full min-w-[760px] border-collapse text-left text-[13px]">
          <thead className="text-xs text-[var(--fg-muted)]">
            <tr className="h-10 border-b border-[var(--border)]">
              <th className="px-6 font-medium">Status</th>
              <th className="px-4 font-medium">Monitor</th>
              <th className="px-4 text-right font-medium">Uptime 24h</th>
              <th className="px-4 text-right font-medium">Latency</th>
              <th className="px-6 text-right font-medium">Last Checked</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((monitor) => (
              <tr
                key={monitor.id}
                onClick={(event) => {
                  navigateFromMonitorRow(event.target, monitor.id, router.push);
                }}
                className={cn(
                  "h-[60px] cursor-pointer border-b border-[var(--border)] last:border-0 hover:bg-[var(--hover)]",
                  monitor.state === "DOWN" && "shadow-[inset_3px_0_var(--down)]",
                )}
              >
                <td className="px-6">
                  <span className="inline-flex items-center gap-2">
                    <StatusDot state={monitor.state} />
                    {stateLabel(monitor.state)}
                  </span>
                </td>
                <td className="px-4">
                  <Link href={`/monitors/${encodeURIComponent(monitor.id)}`} className="font-medium hover:underline">
                    {monitor.name}
                  </Link>
                  <div className="max-w-[320px] truncate font-data text-xs text-[var(--fg-muted)]">
                    {monitor.url}
                  </div>
                </td>
                <td className="px-4 text-right font-data">{formatUptimeTable(monitor.uptime24h)}</td>
                <td className="px-4 text-right font-data">{formatLatency(monitor.lastLatencyMs)}</td>
                <td className="px-6 text-right font-data text-[var(--fg-muted)]">
                  {monitor.lastCheckedAt ? formatRelativeTime(new Date(monitor.lastCheckedAt)) : "Never"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 ? (
          <div className="px-6 py-14 text-center text-[var(--fg-muted)]">
            {monitors.length === 0 ? "Add your first monitor" : "No monitors match"}
          </div>
        ) : null}
      </div>
    </div>
  );
}
