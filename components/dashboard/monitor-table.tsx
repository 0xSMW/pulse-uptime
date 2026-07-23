"use client"

import { Search } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useRef, useState } from "react"

import { useTimezone } from "@/components/dashboard/timezone-provider"
import {
  ExpiryInlineWarnings,
  expiryWarnings,
} from "@/components/monitors/expiry-chip"
import {
  StatusDot,
  type VisibleMonitorState,
} from "@/components/monitors/status-dot"
import {
  TimelineBar,
  type TimelineBucket,
} from "@/components/monitors/timeline-bar"
import { Input } from "@/components/ui/input"
import {
  HOVER_PREFETCH_DELAY_MS,
  isPlainLeftClick,
  navigateRow,
  resolveFullPrefetchOptions,
  shouldPrefetchOnce,
} from "@/components/ui/row-navigation"
import {
  formatLatency,
  formatRelativeTime,
  formatUptimeTable,
} from "@/lib/reporting/format"
import { firstRunPhase } from "@/lib/reporting/queries/first-run"
import { cn } from "@/lib/utils"

// Re-exported so existing importers keep one surface. The row-click helpers
// live in components/ui/row-navigation.
export { HOVER_PREFETCH_DELAY_MS, isPlainLeftClick }

export interface DashboardMonitor {
  id: string
  name: string
  url: string
  state: VisibleMonitorState
  uptime24h: number | null
  latestLatencyMs: number | null
  lastCheckedAt: string | null
  activatedAt: string | null
  activeIncidentOpenedAt: string | null
  uptime24hUnlocked: boolean
  timeline: TimelineBucket[]
  certExpiresAt: string | null
  domainExpiresAt: string | null
}

// The 24h column is a full-window claim, so it stays a placeholder until a
// monitor has been observed for a whole day. A setup-phase monitor has never
// succeeded, a collecting one has less than 24 hours of history, and a monitor
// active by wall clock but activated inside the completed window still lacks a
// full post-activation day, so all three render as a placeholder rather than a
// partial figure passed off as a settled score. The unlock flag carries the
// same completed-bucket gate the detail page applies.
function uptime24hLabel(monitor: DashboardMonitor, now: Date): string {
  const phase = firstRunPhase(
    monitor.activatedAt ? new Date(monitor.activatedAt) : null,
    now
  )
  if (phase === "setup") {
    return "Verifying"
  }
  if (phase === "collecting" || !monitor.uptime24hUnlocked) {
    return "Collecting"
  }
  return formatUptimeTable(monitor.uptime24h)
}

// Prefetch each monitor once.
export function shouldPrefetchMonitor(
  monitorId: string,
  prefetchedIds: Set<string>
): boolean {
  return shouldPrefetchOnce(monitorId, prefetchedIds)
}

export function navigateFromMonitorRow(
  target: EventTarget | null,
  monitorId: string,
  navigate: (href: string) => void
): boolean {
  return navigateRow(
    target,
    `/monitors/${encodeURIComponent(monitorId)}`,
    navigate
  )
}

function stateLabel(state: VisibleMonitorState): string {
  return state
    .toLowerCase()
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ")
}

export function MonitorTable({ monitors }: { monitors: DashboardMonitor[] }) {
  const router = useRouter()
  const { resolvedTimeZone } = useTimezone()
  const [query, setQuery] = useState("")
  const [pendingMonitorId, setPendingMonitorId] = useState<string | null>(null)
  const pendingResetRef = useRef<number | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement>(null)
  const hoverIntentRef = useRef<number | undefined>(undefined)
  const prefetchedIdsRef = useRef<Set<string>>(new Set())

  // Clear pending feedback if navigation does not unmount the table.
  const markPending = (monitorId: string) => {
    setPendingMonitorId(monitorId)
    window.clearTimeout(pendingResetRef.current)
    pendingResetRef.current = window.setTimeout(
      () => setPendingMonitorId(null),
      8000
    )
  }
  useEffect(() => () => window.clearTimeout(pendingResetRef.current), [])

  const prefetchMonitor = (monitorId: string) => {
    if (!shouldPrefetchMonitor(monitorId, prefetchedIdsRef.current)) {
      return
    }
    router.prefetch(
      `/monitors/${encodeURIComponent(monitorId)}`,
      resolveFullPrefetchOptions()
    )
  }

  // Prefetch keyboard focus immediately. Delay pointer hover for intent.
  const handleRowMouseEnter = (monitorId: string) => {
    window.clearTimeout(hoverIntentRef.current)
    hoverIntentRef.current = window.setTimeout(
      () => prefetchMonitor(monitorId),
      HOVER_PREFETCH_DELAY_MS
    )
  }
  const handleRowMouseLeave = () => {
    window.clearTimeout(hoverIntentRef.current)
  }
  useEffect(() => () => window.clearTimeout(hoverIntentRef.current), [])
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) {
      return monitors
    }
    return monitors.filter((monitor) =>
      `${monitor.name}\n${monitor.url}`.toLowerCase().includes(needle)
    )
  }, [monitors, query])

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      const target = event.target as HTMLElement | null
      if (target?.matches("input, textarea, [contenteditable='true']")) {
        return
      }
      event.preventDefault()
      inputRef.current?.focus()
    }
    window.addEventListener("keydown", focusSearch)
    return () => window.removeEventListener("keydown", focusSearch)
  }, [])

  return (
    <div>
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--fg-muted)]" />
        <Input
          aria-label="Search monitors"
          className="pr-10 pl-9"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search monitors"
          ref={inputRef}
          value={query}
        />
        {query ? (
          <button
            aria-label="Clear search"
            className="absolute top-1/2 right-3 -translate-y-1/2 text-[var(--fg-muted)] hover:text-[var(--fg)]"
            onClick={() => setQuery("")}
            type="button"
          >
            ×
          </button>
        ) : (
          <kbd className="absolute top-1/2 right-3 -translate-y-1/2 rounded border border-[var(--border-strong)] px-1.5 font-data text-[10px] text-[var(--fg-muted)]">
            /
          </kbd>
        )}
      </div>
      <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
        <table className="w-full min-w-[960px] border-collapse text-left text-[13px]">
          <thead className="text-[var(--fg-muted)] text-xs">
            <tr className="h-10 border-[var(--border)] border-b">
              <th className="px-6 font-medium">Status</th>
              <th className="px-4 font-medium">Monitor</th>
              <th className="px-4 text-right font-medium">Uptime 24h</th>
              <th className="px-4 font-medium">Timeline</th>
              <th className="px-4 text-right font-medium">Latency</th>
              <th className="px-6 text-right font-medium">Last Checked</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((monitor) => (
              <tr
                className={cn(
                  "h-[60px] cursor-pointer border-[var(--border)] border-b last:border-0 hover:bg-[var(--hover)]",
                  monitor.state === "DOWN" &&
                    "shadow-[inset_3px_0_var(--down)]",
                  pendingMonitorId === monitor.id &&
                    "animate-pulse bg-[var(--hover)]"
                )}
                key={monitor.id}
                onClick={(event) => {
                  if (!isPlainLeftClick(event)) {
                    return
                  }
                  if (
                    navigateFromMonitorRow(
                      event.target,
                      monitor.id,
                      router.push
                    )
                  ) {
                    markPending(monitor.id)
                  }
                }}
                onFocus={() => prefetchMonitor(monitor.id)}
                // Prefetch after hover intent or immediately on keyboard focus.
                onMouseEnter={() => handleRowMouseEnter(monitor.id)}
                onMouseLeave={handleRowMouseLeave}
              >
                <td className="px-6">
                  <span className="inline-flex items-center gap-2">
                    <StatusDot state={monitor.state} />
                    {stateLabel(monitor.state)}
                  </span>
                </td>
                <td className="px-4">
                  <span className="inline-flex max-w-full items-center gap-2">
                    <Link
                      className="truncate font-medium"
                      href={`/monitors/${encodeURIComponent(monitor.id)}`}
                      onClick={(event) => {
                        if (isPlainLeftClick(event)) {
                          markPending(monitor.id)
                        }
                      }}
                      prefetch={false}
                    >
                      {monitor.name}
                    </Link>
                  </span>
                  <div className="flex max-w-[320px] items-center gap-2 font-data text-[var(--fg-muted)] text-xs">
                    <span className="min-w-0 truncate">{monitor.url}</span>
                    <ExpiryInlineWarnings
                      warnings={expiryWarnings(
                        monitor.certExpiresAt,
                        monitor.domainExpiresAt,
                        new Date()
                      )}
                    />
                  </div>
                </td>
                <td className="px-4 text-right font-data">
                  {uptime24hLabel(monitor, new Date())}
                </td>
                <td className="w-[280px] min-w-[220px] px-4">
                  <TimelineBar
                    buckets={monitor.timeline}
                    height={24}
                    label="Last 24 hours"
                    timeZone={resolvedTimeZone}
                  />
                </td>
                <td className="px-4 text-right font-data">
                  {formatLatency(monitor.latestLatencyMs)}
                </td>
                <td className="px-6 text-right font-data text-[var(--fg-muted)]">
                  {monitor.lastCheckedAt
                    ? formatRelativeTime(
                        new Date(monitor.lastCheckedAt),
                        new Date(),
                        resolvedTimeZone
                      )
                    : "Never"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 ? (
          <div className="px-6 py-14 text-center text-[var(--fg-muted)]">
            {monitors.length === 0
              ? "Add your first monitor"
              : "No monitors match"}
          </div>
        ) : null}
      </div>
    </div>
  )
}
