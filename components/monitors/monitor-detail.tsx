"use client"

import { ArrowLeft, ExternalLink } from "lucide-react"
import Link from "next/link"
import { useEffect, useState } from "react"

import type { LatencyPoint } from "@/components/charts/latency-chart"
import { LazyLatencyChart } from "@/components/charts/lazy-latency-chart"
import { useTimezone } from "@/components/dashboard/timezone-provider"
import { DependencyOverlapCard } from "@/components/dependencies/dependency-overlap-card"
import type { DependencyIncidentOverlap } from "@/components/incidents/types"
import {
  ExpiryHeaderChip,
  expiryWarnings,
} from "@/components/monitors/expiry-chip"
import {
  MonitorActions,
  MonitorEditButton,
  MonitorSetupActions,
} from "@/components/monitors/monitor-actions"
import { StatusBadge } from "@/components/monitors/status-badge"
import {
  StatusDot,
  type VisibleMonitorState,
} from "@/components/monitors/status-dot"
import {
  TimelineBar,
  type TimelineBucket,
} from "@/components/monitors/timeline-bar"
import {
  type MonitorLiveStatus,
  useMonitorLive,
} from "@/components/monitors/use-monitor-live"
import type { SettingsGroup } from "@/components/settings/settings-api"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { daysUntil, expiryLevel } from "@/lib/domain-health/expiry"
import {
  formatCalendarDate,
  formatDuration,
  formatLatency,
  formatRelativeDay,
  formatTimestamp,
  formatUptimeDetail,
} from "@/lib/reporting/format"
import { formatUpdatedAgo } from "@/lib/reporting/live-poll"
import {
  type MonitorPhase,
  type UptimeTone,
  uptimeTone,
} from "@/lib/reporting/queries/first-run"
import { cn } from "@/lib/utils"

type AvailabilityRange = "h24" | "d7" | "d30" | "d90"
type ResponseRange = Exclude<AvailabilityRange, "d90">

export interface MonitorDetailData {
  id: string
  name: string
  url: string
  method: string
  groupId: string | null
  group: string | null
  enabled: boolean
  intervalMinutes: number
  timeoutMs: number
  recipients: string[]
  state: VisibleMonitorState
  intervalSeconds: number
  timeoutSeconds: number
  expectedStatusMin: number
  expectedStatusMax: number
  failureThreshold: number
  recoveryThreshold: number
  recipientCount: number
  expectedText: string | null
  domainHealth: {
    apexDomain: string | null
    certExpiresAt: string | null
    certIssuer: string | null
    domainExpiresAt: string | null
    domainRegistrar: string | null
  }
  latestLatencyMs: number | null
  lastCheckedAt: string | null
  p95LatencyMs: number | null
  uptime: Record<AvailabilityRange, number | null>
  coverage: Record<AvailabilityRange, number | null>
  rangeUnlocked: Record<AvailabilityRange, boolean>
  firstRun: {
    phase: MonitorPhase
    activatedAt: string | null
    observedSeconds: number
    observed: {
      uptime: number | null
      completed: number
      expected: number
    }
    setupError: string | null
    lastCheckedAt: string | null
  }
  availability: Record<
    AvailabilityRange,
    { start: string; buckets: TimelineBucket[] }
  >
  responseTime: Record<ResponseRange, LatencyPoint[]>
  latestIncident: {
    id: string
    state: "ONGOING" | "RESOLVED"
    openedAt: string
    resolvedAt: string | null
    durationSeconds: number
    openingFailure: string
    overlaps: DependencyIncidentOverlap[]
  } | null
  recentIncidents: Array<{
    id: string
    openedAt: string
    durationSeconds: number
    openingFailure: string
  }>
  recentChecks: Array<{
    id: string
    checkedAt: string
    successful: boolean
    statusCode: number | null
    resultLabel: string
    latencyMs: number | null
  }>
  rollupVersion: string | null
  acceptedConfigToken: string | null
  windowVersion: string
}

const availabilityRanges: Array<{ key: AvailabilityRange; label: string }> = [
  { key: "h24", label: "24h" },
  { key: "d7", label: "7d" },
  { key: "d30", label: "30d" },
  { key: "d90", label: "90d" },
]

const responseRanges: Array<{ key: ResponseRange; label: string }> = [
  { key: "h24", label: "24h" },
  { key: "d7", label: "7d" },
  { key: "d30", label: "30d" },
]

function formatInterval(seconds: number): string {
  if (seconds % 60 === 0) {
    return `${seconds / 60}m`
  }
  return `${seconds}s`
}

// Splits the display URL around its registrable apex so only that segment
// carries the domain tooltip affordance. Null when the apex is unknown or the
// URL does not contain it, in which case the URL renders plain.
function splitUrlAtApex(
  url: string,
  apex: string | null
): { prefix: string; apex: string; suffix: string } | null {
  if (!apex) {
    return null
  }
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return null
  }
  if (hostname !== apex && !hostname.endsWith(`.${apex}`)) {
    return null
  }
  const hostStart = url.indexOf(hostname)
  if (hostStart < 0) {
    return null
  }
  const apexStart = hostStart + hostname.length - apex.length
  return {
    prefix: url.slice(0, apexStart),
    apex: url.slice(apexStart, apexStart + apex.length),
    suffix: url.slice(apexStart + apex.length),
  }
}

function expiresLine(
  label: string,
  expiresAt: string,
  detail: string | null,
  timeZone: string,
  now: Date
): string {
  const days = daysUntil(new Date(expiresAt), now)
  const when = formatCalendarDate(expiresAt, timeZone)
  const timing = days < 0 ? `${-days}d ago` : `in ${days}d`
  return `${label} ${when} · ${timing}${detail ? ` · ${detail}` : ""}`
}

/**
 * Option B affordance: a dotted underline on the apex segment of the header
 * URL, hover or focus revealing renewal and certificate facts. Absent facts
 * render the URL plain, so a TLD without RDAP coverage adds nothing.
 */
function MonitorUrlLabel({
  url,
  domainHealth,
  timeZone,
}: {
  url: string
  domainHealth: MonitorDetailData["domainHealth"]
  timeZone: string
}) {
  const segments = splitUrlAtApex(url, domainHealth.apexDomain)
  const hasFacts =
    domainHealth.certExpiresAt !== null || domainHealth.domainExpiresAt !== null
  if (!(segments && hasFacts)) {
    return <>{url}</>
  }
  const now = new Date()
  const warning = expiryWarnings(
    domainHealth.certExpiresAt,
    domainHealth.domainExpiresAt,
    now
  )[0]
  return (
    <>
      {segments.prefix}
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(
                "underline decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]",
                warning?.level === "critical"
                  ? "decoration-[var(--down-text)]"
                  : warning
                    ? "decoration-[var(--verifying-text)]"
                    : "decoration-[var(--fg-muted)]"
              )}
              tabIndex={0}
            />
          }
        >
          {segments.apex}
        </TooltipTrigger>
        <TooltipContent className="px-3 py-2">
          <div className="space-y-1 text-left">
            <p className="font-medium">{segments.apex}</p>
            {domainHealth.domainExpiresAt ? (
              <p className="text-[var(--fg-muted)]">
                {expiresLine(
                  "Renews",
                  domainHealth.domainExpiresAt,
                  domainHealth.domainRegistrar,
                  timeZone,
                  now
                )}
              </p>
            ) : null}
            {domainHealth.certExpiresAt ? (
              <p className="text-[var(--fg-muted)]">
                {expiresLine(
                  "Cert expires",
                  domainHealth.certExpiresAt,
                  domainHealth.certIssuer,
                  timeZone,
                  now
                )}
              </p>
            ) : null}
          </div>
        </TooltipContent>
      </Tooltip>
      {segments.suffix}
    </>
  )
}

const toneClass: Record<UptimeTone, string> = {
  healthy: "text-[var(--fg)]",
  degraded: "text-[var(--verifying-text)]",
  down: "text-[var(--down-text)]",
  collecting: "text-[var(--fg-muted)]",
  unknown: "text-[var(--fg-muted)]",
}

// Coverage renders 100 percent only when every expected check ran. Anything
// short floors to one decimal, never rounding a gap away, so 1433 of 1440
// reads 99.5 percent rather than a false 100 percent that hides the stall.
function formatCoverage(value: number | null): string {
  if (value === null) {
    return "—"
  }
  const percent = value * 100
  if (percent >= 100) {
    return "100%"
  }
  return `${(Math.floor(percent * 10) / 10).toFixed(1)}%`
}

function RangeButtons<T extends string>({
  ranges,
  value,
  onChange,
  label,
}: {
  ranges: Array<{ key: T; label: string }>
  value: T
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div
      aria-label={label}
      className="inline-flex rounded-md bg-[var(--chip-bg)] p-0.5"
      role="group"
    >
      {ranges.map((range) => (
        <button
          aria-pressed={value === range.key}
          className={cn(
            "h-7 min-w-10 rounded px-2 font-data text-[var(--fg-muted)] text-xs transition-colors",
            value === range.key &&
              "bg-[var(--bg)] text-[var(--fg)] shadow-[var(--card-shadow)]"
          )}
          key={range.key}
          onClick={() => onChange(range.key)}
          type="button"
        >
          {range.label}
        </button>
      ))}
    </div>
  )
}

// Quiet freshness indicator. "Live" while polling, "Updates paused" when the
// tab is hidden, "Data may be stale" after repeated refresh failures, with an
// "Updated Ns ago" note that ticks each second.
function LiveIndicator({ status }: { status: MonitorLiveStatus }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const label = status.isStale
    ? "Data may be stale"
    : status.isPaused
      ? "Updates paused"
      : "Live"
  const dotClass = status.isStale
    ? "bg-[var(--down)]"
    : status.isPaused
      ? "bg-[var(--neutral-state)]"
      : "bg-[var(--up)]"
  const secondsAgo =
    status.updatedAt === null
      ? null
      : Math.round((now - status.updatedAt) / 1000)

  return (
    <span className="inline-flex items-center gap-1.5 font-data text-[11px] text-[var(--fg-muted)]">
      <span aria-hidden className={cn("size-1.5 rounded-full", dotClass)} />
      {/* Only the status label is announced, and only when it changes. The
          Updated Ns ago counter ticks every second, so it stays visible to
          sighted users but aria-hidden to keep screen readers from
          re-announcing the timestamp each second. */}
      <span aria-live="polite">{label}</span>
      {secondsAgo !== null && !status.isPaused ? (
        <span aria-hidden className="text-[var(--fg-faint)]">
          · {formatUpdatedAgo(secondsAgo)}
        </span>
      ) : null}
    </span>
  )
}

// The recent incidents and checks tables read as relative days, but that label
// depends on the current moment, which differs between the server render and
// hydration. The mounted flag holds the now-independent absolute timestamp
// through SSR and the first client render, then swaps to the relative label
// after mount. This rides the same post-hydration pass that swaps the viewer
// zone in from UTC, so it adds no new flash and no hydration mismatch.
function RelativeTimestamp({
  mounted,
  timeZone,
  value,
}: {
  mounted: boolean
  timeZone: string
  value: string
}) {
  if (!mounted) {
    return <>{formatTimestamp(value, timeZone)}</>
  }
  return <>{formatRelativeDay(new Date(value), new Date(), timeZone)}</>
}

function EmptyCardContent({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-28 items-center justify-center text-[13px] text-[var(--fg-muted)]">
      {children}
    </div>
  )
}

function UptimeStat({
  label,
  unlocked,
  value,
  coverage,
  tone,
}: {
  label: string
  unlocked: boolean
  value: number | null
  coverage: number | null
  tone: UptimeTone
}) {
  return (
    <Card className="min-w-0">
      <CardContent>
        <p className="text-[var(--fg-muted)] text-xs">{label}</p>
        {unlocked ? (
          <>
            <p className={cn("mt-2 font-data text-xl", toneClass[tone])}>
              {formatUptimeDetail(value)}
            </p>
            <p className="mt-1 font-data text-[var(--fg-muted)] text-xs">
              Coverage {formatCoverage(coverage)}
            </p>
          </>
        ) : (
          <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
            Collecting data
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function ObservedUptimeStat({
  firstRun,
  tone,
}: {
  firstRun: MonitorDetailData["firstRun"]
  tone: UptimeTone
}) {
  return (
    <Card className="min-w-0">
      <CardContent>
        <p className="text-[var(--fg-muted)] text-xs">Observed uptime</p>
        <p className={cn("mt-2 font-data text-xl", toneClass[tone])}>
          {formatUptimeDetail(firstRun.observed.uptime)}
        </p>
        <p className="mt-1 text-[var(--fg-muted)] text-xs">
          Since monitoring began · {formatDuration(firstRun.observedSeconds)}{" "}
          observed
        </p>
        <p className="mt-1 font-data text-[var(--fg-muted)] text-xs">
          {firstRun.observed.completed} of {firstRun.observed.expected} checks
        </p>
      </CardContent>
    </Card>
  )
}

function SetupStat() {
  return (
    <Card className="min-w-0">
      <CardContent>
        <p className="text-[var(--fg-muted)] text-xs">Status</p>
        <p className="mt-2 text-xl">Verifying setup</p>
        <p className="mt-1 text-[var(--fg-muted)] text-xs">
          Monitoring begins at the first successful check
        </p>
      </CardContent>
    </Card>
  )
}

export function MonitorDetail({
  canManageMonitors,
  monitor: snapshot,
  groups,
}: {
  canManageMonitors: boolean
  monitor: MonitorDetailData
  groups: readonly SettingsGroup[]
}) {
  const { resolvedTimeZone } = useTimezone()
  const live = useMonitorLive(snapshot.id, {
    phase: snapshot.firstRun.phase,
    state: snapshot.state,
    rollupVersion: snapshot.rollupVersion,
    acceptedConfigToken: snapshot.acceptedConfigToken,
    windowVersion: snapshot.windowVersion,
    rangeUnlocked: snapshot.rangeUnlocked,
  })
  // Merge the polled fields over the snapshot in place. Charts, timeline
  // buckets, and configuration stay on the snapshot until a rollup refresh
  // advances them through router.refresh. Uptime and coverage merge per range,
  // so the d30 and d90 values the live payload omits fall back to the snapshot.
  // The d30 and d90 unlock flags also stay on the snapshot, so a live flag never
  // unlocks a long range whose score did not arrive. The hook refreshes once
  // when the poll crosses that boundary so the server fills both in together.
  // The merge applies only when the payload names this monitor. SWR
  // keepPreviousData holds the prior monitor's payload under the new key across a
  // direct navigation, so a mismatched id falls back to the server snapshot
  // rather than painting the prior monitor's state over this one.
  const monitor: MonitorDetailData =
    live.data && live.data.id === snapshot.id
      ? {
          ...snapshot,
          ...live.data,
          uptime: { ...snapshot.uptime, ...live.data.uptime },
          coverage: { ...snapshot.coverage, ...live.data.coverage },
          rangeUnlocked: {
            ...live.data.rangeUnlocked,
            d30: snapshot.rangeUnlocked.d30,
            d90: snapshot.rangeUnlocked.d90,
          },
          // The live payload carries the incident's live fields but not the
          // dependency overlaps, which ride the server snapshot and only change on
          // a full refresh. Carry them across only when the live incident is the
          // same incident as the snapshot's, matched by id, so a live update never
          // drops the overlap card. A brand-new incident the poll surfaces first
          // has a different id, so it shows no overlaps until router.refresh
          // recomputes them and never inherits the prior incident's overlaps.
          latestIncident: live.data.latestIncident
            ? {
                ...live.data.latestIncident,
                overlaps:
                  live.data.latestIncident.id === snapshot.latestIncident?.id
                    ? // biome-ignore lint/suspicious/noUnnecessaryConditions: typescript does not narrow the optional incident through the id comparison
                      (snapshot.latestIncident?.overlaps ?? [])
                    : [],
              }
            : null,
        }
      : snapshot
  const headerExpiryWarnings = expiryWarnings(
    monitor.domainHealth.certExpiresAt,
    monitor.domainHealth.domainExpiresAt,
    new Date()
  )
  const [availabilityRange, setAvailabilityRange] =
    useState<AvailabilityRange>("h24")
  const [responseRange, setResponseRange] = useState<ResponseRange>("h24")
  // Relative timestamps depend on the current moment, so they stay on the
  // deterministic absolute label until after the client mounts.
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  const availability = monitor.availability[availabilityRange]
  const responseTime = monitor.responseTime[responseRange]
  const { phase } = monitor.firstRun
  // Red is reserved for the present. An ongoing incident or a down state is
  // the only thing that turns an uptime figure red. A recently resolved
  // incident degrades it to amber instead.
  const currentlyDown =
    monitor.state === "DOWN" || monitor.latestIncident?.state === "ONGOING"
  const recentlyDegraded = monitor.latestIncident?.state === "RESOLVED"
  const toneFor = (range: AvailabilityRange): UptimeTone =>
    uptimeTone({
      unlocked: monitor.rangeUnlocked[range],
      currentlyDown,
      recentlyDegraded,
      uptime: monitor.uptime[range],
    })
  const availabilityUnlocked = monitor.rangeUnlocked[availabilityRange]

  return (
    <div className="space-y-6">
      <header>
        <Link
          className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
          href="/"
        >
          <ArrowLeft aria-hidden className="size-3.5" />
          Overview
        </Link>
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="font-semibold text-xl tracking-[-0.02em]">
                {monitor.name}
              </h1>
              <StatusBadge state={monitor.state} />
              <LiveIndicator status={live} />
              {headerExpiryWarnings.map((warning) => (
                <ExpiryHeaderChip key={warning.kind} warning={warning} />
              ))}
            </div>
            <div className="mt-2 flex min-w-0 items-center gap-2 font-data text-[13px] text-[var(--fg-muted)]">
              <span className="rounded bg-[var(--chip-bg)] px-1.5 py-0.5 font-medium text-[11px] text-[var(--fg)]">
                {monitor.method}
              </span>
              <a
                className="min-w-0 truncate transition-colors duration-150 hover:text-[var(--fg)]"
                href={monitor.url}
                rel="noreferrer"
                target="_blank"
                title={monitor.url}
              >
                <MonitorUrlLabel
                  domainHealth={monitor.domainHealth}
                  timeZone={resolvedTimeZone}
                  url={monitor.url}
                />
              </a>
              <ExternalLink aria-hidden className="size-3 shrink-0" />
            </div>
          </div>
          <MonitorActions
            canManageMonitors={canManageMonitors}
            groups={groups}
            monitor={monitor}
          />
        </div>
      </header>

      <section
        aria-label="Monitor statistics"
        className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3"
      >
        <Card className="min-w-0">
          <CardContent>
            <p className="text-[var(--fg-muted)] text-xs">Latest Latency</p>
            <p className="mt-2 font-data text-xl">
              {formatLatency(monitor.latestLatencyMs)}
            </p>
            <p className="mt-1 font-data text-[var(--fg-muted)] text-xs">
              p95 {formatLatency(monitor.p95LatencyMs)}
            </p>
          </CardContent>
        </Card>
        {phase === "setup" ? <SetupStat /> : null}
        {phase === "collecting" ? (
          <ObservedUptimeStat
            firstRun={monitor.firstRun}
            tone={uptimeTone({
              unlocked: true,
              currentlyDown,
              recentlyDegraded,
              uptime: monitor.firstRun.observed.uptime,
            })}
          />
        ) : null}
        {phase === "active"
          ? (["h24", "d7", "d30"] as const).map((range) => (
              <UptimeStat
                coverage={monitor.coverage[range]}
                key={range}
                label={`Uptime ${availabilityRanges.find((entry) => entry.key === range)?.label}`}
                tone={toneFor(range)}
                unlocked={monitor.rangeUnlocked[range]}
                value={monitor.uptime[range]}
              />
            ))
          : null}
      </section>

      {phase === "setup" ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4 text-[13px]">
          <span className="flex items-center gap-2">
            <StatusDot state="PENDING" />
            <span className="font-medium">Verifying setup</span>
          </span>
          <p className="mt-1.5 text-[var(--fg-muted)]">
            {monitor.firstRun.setupError
              ? canManageMonitors
                ? `The last check failed with ${monitor.firstRun.setupError}. Setup failures are warnings, not incidents. Fix the endpoint or edit the configuration, then run a test to confirm it is reachable. Monitoring begins at the next scheduled check that succeeds.`
                : `The last check failed with ${monitor.firstRun.setupError}. Setup failures are warnings, not incidents. Monitoring begins at the next scheduled check that succeeds.`
              : "Monitoring officially begins after the first successful check. No incidents or downtime are recorded during setup."}
          </p>
          <MonitorSetupActions
            canManageMonitors={canManageMonitors}
            groups={groups}
            monitor={monitor}
          />
        </div>
      ) : null}

      {monitor.latestIncident ? (
        <>
          <Link
            className={cn(
              "flex flex-col justify-between gap-2 rounded-xl border p-4 text-[13px] transition-colors hover:border-[var(--border-hover)] sm:flex-row sm:items-center",
              monitor.latestIncident.state === "ONGOING"
                ? "border-[var(--down-border)] bg-[var(--down-bg)]"
                : "border-[var(--border)] bg-[var(--bg)]"
            )}
            href={`/incidents/${encodeURIComponent(monitor.latestIncident.id)}`}
          >
            <span className="flex min-w-0 items-center gap-2">
              <StatusDot
                state={
                  monitor.latestIncident.state === "ONGOING" ? "DOWN" : "UP"
                }
              />
              <span className="font-medium">
                {monitor.latestIncident.state === "ONGOING"
                  ? "Ongoing incident"
                  : "Recently resolved"}
              </span>
              <span className="truncate font-data text-[var(--fg-muted)]">
                {monitor.latestIncident.openingFailure}
              </span>
            </span>
            <span className="shrink-0 font-data text-[var(--fg-muted)]">
              {formatTimestamp(
                monitor.latestIncident.openedAt,
                resolvedTimeZone
              )}{" "}
              · {formatDuration(monitor.latestIncident.durationSeconds)}
            </span>
          </Link>
          <DependencyOverlapCard overlaps={monitor.latestIncident.overlaps} />
        </>
      ) : null}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Availability</CardTitle>
            {availabilityUnlocked ? (
              <p
                className={cn(
                  "mt-1 font-data text-[13px]",
                  toneClass[toneFor(availabilityRange)]
                )}
              >
                {formatUptimeDetail(monitor.uptime[availabilityRange])}
                <span className="ml-2 text-[var(--fg-muted)]">
                  Coverage {formatCoverage(monitor.coverage[availabilityRange])}
                </span>
              </p>
            ) : (
              <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
                Collecting data
              </p>
            )}
          </div>
          <RangeButtons
            label="Availability range"
            onChange={setAvailabilityRange}
            ranges={availabilityRanges}
            value={availabilityRange}
          />
        </CardHeader>
        <CardContent>
          {availability.buckets.length ? (
            <>
              <TimelineBar
                buckets={availability.buckets}
                height={32}
                label={`${availabilityRanges.find((range) => range.key === availabilityRange)?.label} availability`}
                timeZone={resolvedTimeZone}
              />
              <div className="mt-2 flex justify-between font-data text-[11px] text-[var(--fg-faint)]">
                <span>
                  {formatTimestamp(availability.start, resolvedTimeZone)}
                </span>
                <span>Now</span>
              </div>
            </>
          ) : (
            <EmptyCardContent>No availability data yet</EmptyCardContent>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4">
          <CardTitle>Response Time</CardTitle>
          <RangeButtons
            label="Response time range"
            onChange={setResponseRange}
            ranges={responseRanges}
            value={responseRange}
          />
        </CardHeader>
        <CardContent>
          {responseTime.length ? (
            <LazyLatencyChart data={responseTime} />
          ) : (
            <EmptyCardContent>No response data yet</EmptyCardContent>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="flex-row items-center justify-between gap-4">
            <CardTitle>Recent Incidents</CardTitle>
            {/* The View All control keeps its own height, so a negative block
                margin collapses its contribution to the header row back to the
                title line. The header then matches the Recent Checks card
                beside it exactly. */}
            <Link
              className={cn(
                buttonVariants({ variant: "tertiary", size: "sm" }),
                "-my-1.5"
              )}
              href={`/incidents?monitor=${encodeURIComponent(monitor.id)}`}
            >
              View All
            </Link>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {monitor.recentIncidents.length ? (
              <div className="hide-scrollbar overflow-x-auto">
                <table className="w-full min-w-[580px] border-collapse text-left text-[13px]">
                  <thead className="text-[var(--fg-muted)] text-xs">
                    <tr className="h-10 border-[var(--border)] border-y">
                      <th className="px-6 font-medium">Started</th>
                      <th className="px-4 font-medium">Duration</th>
                      <th className="px-6 font-medium">Opening Failure</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monitor.recentIncidents.map((incident) => (
                      <tr
                        className="h-12 border-[var(--border)] border-b last:border-0 hover:bg-[var(--hover)]"
                        key={incident.id}
                      >
                        <td className="whitespace-nowrap px-6 font-data">
                          <Link
                            className="transition-opacity duration-150 hover:opacity-70"
                            href={`/incidents/${encodeURIComponent(incident.id)}`}
                          >
                            <RelativeTimestamp
                              mounted={mounted}
                              timeZone={resolvedTimeZone}
                              value={incident.openedAt}
                            />
                          </Link>
                        </td>
                        <td className="whitespace-nowrap px-4 font-data">
                          {formatDuration(incident.durationSeconds)}
                        </td>
                        <td
                          className="max-w-64 truncate px-6 font-data"
                          title={incident.openingFailure}
                        >
                          {incident.openingFailure}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyCardContent>No incidents yet</EmptyCardContent>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 overflow-hidden">
          <CardHeader>
            <CardTitle>Recent Checks</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {monitor.recentChecks.length ? (
              <div className="hide-scrollbar overflow-x-auto">
                <table className="w-full min-w-[480px] border-collapse text-left text-[13px]">
                  <thead className="text-[var(--fg-muted)] text-xs">
                    <tr className="h-10 border-[var(--border)] border-y">
                      <th className="px-6 font-medium">Time</th>
                      <th className="px-4 font-medium">Result</th>
                      <th className="px-6 text-right font-medium">Latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monitor.recentChecks.map((check) => (
                      <tr
                        className={cn(
                          "h-12 border-[var(--border)] border-b last:border-0",
                          !check.successful &&
                            "bg-[color-mix(in_srgb,var(--down-bg)_40%,transparent)]"
                        )}
                        key={check.id}
                      >
                        <td className="whitespace-nowrap px-6 font-data">
                          <RelativeTimestamp
                            mounted={mounted}
                            timeZone={resolvedTimeZone}
                            value={check.checkedAt}
                          />
                        </td>
                        <td
                          className={cn(
                            "px-4 font-data",
                            !check.successful && "text-[var(--down-text)]"
                          )}
                        >
                          <span className="inline-flex items-center gap-2 whitespace-nowrap">
                            <span
                              aria-hidden
                              className={cn(
                                "size-1.5 rounded-full",
                                check.successful
                                  ? "bg-[var(--up)]"
                                  : "bg-[var(--down)]"
                              )}
                            />
                            {check.resultLabel}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-6 text-right font-data">
                          {formatLatency(check.latencyMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyCardContent>No checks recorded yet</EmptyCardContent>
            )}
          </CardContent>
        </Card>
      </div>

      {monitor.domainHealth.certExpiresAt ||
      monitor.domainHealth.domainExpiresAt ? (
        <Card id="domain-certificate">
          <CardHeader>
            <CardTitle>Domain &amp; Certificate</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
              {monitor.domainHealth.certExpiresAt ? (
                <ExpiryField
                  expiresAt={monitor.domainHealth.certExpiresAt}
                  label="Certificate expires"
                  timeZone={resolvedTimeZone}
                />
              ) : null}
              {monitor.domainHealth.certIssuer ? (
                <ConfigurationField
                  label="Issued by"
                  value={monitor.domainHealth.certIssuer}
                />
              ) : null}
              {monitor.domainHealth.domainExpiresAt ? (
                <ExpiryField
                  expiresAt={monitor.domainHealth.domainExpiresAt}
                  label="Domain renews"
                  timeZone={resolvedTimeZone}
                />
              ) : null}
              {monitor.domainHealth.domainRegistrar ? (
                <ConfigurationField
                  label="Registrar"
                  value={monitor.domainHealth.domainRegistrar}
                />
              ) : null}
              <ConfigurationField
                label="Verified"
                value="Daily, certificate by TLS probe and domain by RDAP"
              />
            </dl>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4">
          <CardTitle>Configuration</CardTitle>
          <MonitorEditButton
            canManageMonitors={canManageMonitors}
            groups={groups}
            monitor={monitor}
          />
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
            <ConfigurationField label="Method" value={monitor.method} />
            <ConfigurationField
              label="Interval"
              value={formatInterval(monitor.intervalSeconds)}
            />
            <ConfigurationField
              label="Timeout"
              value={`${monitor.timeoutSeconds}s`}
            />
            <ConfigurationField
              label="Expected Status"
              value={`${monitor.expectedStatusMin}–${monitor.expectedStatusMax}`}
            />
            <ConfigurationField
              label="Thresholds"
              value={`${monitor.failureThreshold} failures · ${monitor.recoveryThreshold} recoveries`}
            />
            <ConfigurationField
              label="Recipients"
              value={`${monitor.recipientCount} ${monitor.recipientCount === 1 ? "recipient" : "recipients"}`}
            />
            {monitor.expectedText ? (
              <ConfigurationField
                label="Content Match"
                value={`"${monitor.expectedText}"`}
              />
            ) : null}
          </dl>
        </CardContent>
      </Card>
    </div>
  )
}

// An expiry date with its day countdown, toned by the shared warning ladder so
// the card, the header chip, and the URL tooltip always agree.
function ExpiryField({
  label,
  expiresAt,
  timeZone,
}: {
  label: string
  expiresAt: string
  timeZone: string
}) {
  const now = new Date()
  const days = daysUntil(new Date(expiresAt), now)
  const level = expiryLevel(new Date(expiresAt), now)
  const tone =
    level === "critical"
      ? "text-[var(--down-text)]"
      : level === "warning"
        ? "text-[var(--verifying-text)]"
        : "text-[var(--fg-muted)]"
  return (
    <div>
      <dt className="text-[var(--fg-muted)] text-xs">{label}</dt>
      <dd className="mt-1 font-data text-[13px]">
        {formatCalendarDate(expiresAt, timeZone)}{" "}
        <span className={tone}>
          {days < 0 ? `(${-days}d ago)` : `(${days} days)`}
        </span>
      </dd>
    </div>
  )
}

function ConfigurationField({
  label,
  value,
}: {
  label: string
  value: string
}) {
  return (
    <div>
      <dt className="text-[var(--fg-muted)] text-xs">{label}</dt>
      <dd className="mt-1 font-data text-[13px]">{value}</dd>
    </div>
  )
}
