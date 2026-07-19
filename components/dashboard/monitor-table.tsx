"use client";

import { Search } from "lucide-react";
import Link from "next/link";
// Private path: as of Next 16.2.10, `next/navigation` exposes no public way
// to request a FULL (dynamic-data) prefetch — router.prefetch()'s public
// PrefetchOptions.kind type traces back to this same internal enum with no
// public re-export. Access is isolated behind resolveFullPrefetchOptions()
// below so a future Next upgrade that renames/removes PrefetchKind.FULL
// degrades to a shell-only prefetch instead of throwing on every row hover.
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { useTimezone } from "@/components/dashboard/timezone-provider";
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

// Only fire the hover-triggered prefetch once the pointer has rested on a
// row for this long — sweeping the mouse across N rows on the way to a
// target would otherwise fire N full server-rendered prefetches.
export const HOVER_PREFETCH_DELAY_MS = 120;

// Resolved once (lazily) and cached for the module's lifetime. Isolated here
// so the fragile private import above only has one call site: if
// PrefetchKind.FULL is ever missing/renamed, this catches it and callers
// silently fall back to an un-optioned (shell-only) router.prefetch() call
// instead of the page crashing.
let cachedFullPrefetchOptions: { kind: PrefetchKind } | undefined;
let resolvedFullPrefetchOptions = false;
function resolveFullPrefetchOptions(): { kind: PrefetchKind } | undefined {
  if (!resolvedFullPrefetchOptions) {
    resolvedFullPrefetchOptions = true;
    try {
      cachedFullPrefetchOptions = PrefetchKind.FULL ? { kind: PrefetchKind.FULL } : undefined;
    } catch {
      cachedFullPrefetchOptions = undefined;
    }
  }
  return cachedFullPrefetchOptions;
}

// Tracks which monitor ids have already been prefetched so a row that's
// hovered/focused repeatedly only ever issues one full prefetch. Pure and
// standalone so it's unit-testable without mounting the table.
export function shouldPrefetchMonitor(monitorId: string, prefetchedIds: Set<string>): boolean {
  if (prefetchedIds.has(monitorId)) return false;
  prefetchedIds.add(monitorId);
  return true;
}

// Modified/aux clicks open new tabs (or nothing) — no client navigation
// happens in this tab, so they must not enter the pending state.
export function isPlainLeftClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.defaultPrevented
  );
}

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
  const { resolvedTimeZone } = useTimezone();
  const [query, setQuery] = useState("");
  const [pendingMonitorId, setPendingMonitorId] = useState<string | null>(null);
  const pendingResetRef = useRef<number | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const hoverIntentRef = useRef<number | undefined>(undefined);
  const prefetchedIdsRef = useRef<Set<string>>(new Set());

  // Successful navigation unmounts the table; this failsafe clears the pulse
  // when it doesn't (superseded navigation, error, modified click slipping by).
  const markPending = (monitorId: string) => {
    setPendingMonitorId(monitorId);
    window.clearTimeout(pendingResetRef.current);
    pendingResetRef.current = window.setTimeout(() => setPendingMonitorId(null), 8_000);
  };
  useEffect(() => () => window.clearTimeout(pendingResetRef.current), []);

  const prefetchMonitor = (monitorId: string) => {
    if (!shouldPrefetchMonitor(monitorId, prefetchedIdsRef.current)) return;
    router.prefetch(`/monitors/${encodeURIComponent(monitorId)}`, resolveFullPrefetchOptions());
  };

  // Keyboard focus is a deliberate signal, so prefetch right away; a mouse
  // sweeping past the row on its way elsewhere should not.
  const handleRowMouseEnter = (monitorId: string) => {
    window.clearTimeout(hoverIntentRef.current);
    hoverIntentRef.current = window.setTimeout(() => prefetchMonitor(monitorId), HOVER_PREFETCH_DELAY_MS);
  };
  const handleRowMouseLeave = () => {
    window.clearTimeout(hoverIntentRef.current);
  };
  useEffect(() => () => window.clearTimeout(hoverIntentRef.current), []);
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
                  if (!isPlainLeftClick(event)) return;
                  if (navigateFromMonitorRow(event.target, monitor.id, router.push)) {
                    markPending(monitor.id);
                  }
                }}
                // Rows are unbounded, so no viewport prefetch — a full dynamic
                // prefetch fires on hover/focus instead, when intent is clear.
                onMouseEnter={() => handleRowMouseEnter(monitor.id)}
                onMouseLeave={handleRowMouseLeave}
                onFocus={() => prefetchMonitor(monitor.id)}
                className={cn(
                  "h-[60px] cursor-pointer border-b border-[var(--border)] last:border-0 hover:bg-[var(--hover)]",
                  monitor.state === "DOWN" && "shadow-[inset_3px_0_var(--down)]",
                  pendingMonitorId === monitor.id && "animate-pulse bg-[var(--hover)]",
                )}
              >
                <td className="px-6">
                  <span className="inline-flex items-center gap-2">
                    <StatusDot state={monitor.state} />
                    {stateLabel(monitor.state)}
                  </span>
                </td>
                <td className="px-4">
                  <Link
                    href={`/monitors/${encodeURIComponent(monitor.id)}`}
                    prefetch={false}
                    onClick={(event) => {
                      if (isPlainLeftClick(event)) markPending(monitor.id);
                    }}
                    className="font-medium hover:underline"
                  >
                    {monitor.name}
                  </Link>
                  <div className="max-w-[320px] truncate font-data text-xs text-[var(--fg-muted)]">
                    {monitor.url}
                  </div>
                </td>
                <td className="px-4 text-right font-data">{formatUptimeTable(monitor.uptime24h)}</td>
                <td className="px-4 text-right font-data">{formatLatency(monitor.lastLatencyMs)}</td>
                <td className="px-6 text-right font-data text-[var(--fg-muted)]">
                  {monitor.lastCheckedAt ? formatRelativeTime(new Date(monitor.lastCheckedAt), new Date(), resolvedTimeZone) : "Never"}
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
