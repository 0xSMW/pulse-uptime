"use client";

import { ArrowLeft, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import type { LatencyPoint } from "@/components/charts/latency-chart";
import { LazyLatencyChart } from "@/components/charts/lazy-latency-chart";
import { useTimezone } from "@/components/dashboard/timezone-provider";
import {
  useMonitorLive,
  type MonitorLiveStatus,
} from "@/components/monitors/use-monitor-live";
import { StatusBadge } from "@/components/monitors/status-badge";
import {
  MonitorActions,
  MonitorEditButton,
  MonitorRunTestButton,
} from "@/components/monitors/monitor-actions";
import { StatusDot, type MonitorState } from "@/components/monitors/status-dot";
import { TimelineBar, type TimelineBucket } from "@/components/monitors/timeline-bar";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatDuration,
  formatLatency,
  formatUptimeDetail,
} from "@/lib/reporting/format";
import { formatUpdatedAgo } from "@/lib/reporting/live-poll";
import {
  uptimeTone,
  type MonitorPhase,
  type UptimeTone,
} from "@/lib/reporting/queries/first-run";
import { cn } from "@/lib/utils";

type AvailabilityRange = "h24" | "d7" | "d30" | "d90";
type ResponseRange = Exclude<AvailabilityRange, "d90">;

export type MonitorDetailData = {
  id: string;
  name: string;
  url: string;
  method: string;
  group: string | null;
  enabled: boolean;
  intervalMinutes: number;
  timeoutMs: number;
  recipients: string[];
  state: MonitorState;
  intervalSeconds: number;
  timeoutSeconds: number;
  expectedStatusMin: number;
  expectedStatusMax: number;
  failureThreshold: number;
  recoveryThreshold: number;
  recipientCount: number;
  latestLatencyMs: number | null;
  lastCheckedAt: string | null;
  p95LatencyMs: number | null;
  uptime: Record<AvailabilityRange, number | null>;
  coverage: Record<AvailabilityRange, number | null>;
  rangeUnlocked: Record<AvailabilityRange, boolean>;
  firstRun: {
    phase: MonitorPhase;
    activatedAt: string | null;
    observedSeconds: number;
    observed: {
      uptime: number | null;
      completed: number;
      expected: number;
    };
    setupError: string | null;
    lastCheckedAt: string | null;
  };
  availability: Record<
    AvailabilityRange,
    { start: string; buckets: TimelineBucket[] }
  >;
  responseTime: Record<ResponseRange, LatencyPoint[]>;
  latestIncident: {
    id: string;
    state: "ONGOING" | "RESOLVED";
    openedAt: string;
    resolvedAt: string | null;
    durationSeconds: number;
    openingFailure: string;
  } | null;
  recentIncidents: Array<{
    id: string;
    openedAt: string;
    durationSeconds: number;
    openingFailure: string;
  }>;
  recentChecks: Array<{
    id: string;
    checkedAt: string;
    successful: boolean;
    statusCode: number | null;
    resultLabel: string;
    latencyMs: number | null;
  }>;
  rollupVersion: string | null;
};

const availabilityRanges: Array<{ key: AvailabilityRange; label: string }> = [
  { key: "h24", label: "24h" },
  { key: "d7", label: "7d" },
  { key: "d30", label: "30d" },
  { key: "d90", label: "90d" },
];

const responseRanges: Array<{ key: ResponseRange; label: string }> = [
  { key: "h24", label: "24h" },
  { key: "d7", label: "7d" },
  { key: "d30", label: "30d" },
];

function formatTimestamp(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(value));
}

function formatInterval(seconds: number): string {
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

const toneClass: Record<UptimeTone, string> = {
  healthy: "text-[var(--fg)]",
  degraded: "text-[var(--verifying-text)]",
  down: "text-[var(--down-text)]",
  collecting: "text-[var(--fg-muted)]",
  unknown: "text-[var(--fg-muted)]",
};

// Coverage renders 100 percent only when every expected check ran. Anything
// short floors to one decimal, never rounding a gap away, so 1433 of 1440
// reads 99.5 percent rather than a false 100 percent that hides the stall.
function formatCoverage(value: number | null): string {
  if (value === null) return "—";
  const percent = value * 100;
  if (percent >= 100) return "100%";
  return `${(Math.floor(percent * 10) / 10).toFixed(1)}%`;
}

function RangeButtons<T extends string>({
  ranges,
  value,
  onChange,
  label,
}: {
  ranges: Array<{ key: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      className="inline-flex rounded-md bg-[var(--chip-bg)] p-0.5"
      aria-label={label}
    >
      {ranges.map((range) => (
        <button
          key={range.key}
          type="button"
          aria-pressed={value === range.key}
          onClick={() => onChange(range.key)}
          className={cn(
            "h-7 min-w-10 rounded px-2 font-data text-xs text-[var(--fg-muted)] transition-colors",
            value === range.key &&
              "bg-[var(--bg)] text-[var(--fg)] shadow-[var(--card-shadow)]",
          )}
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}

// Quiet freshness indicator. "Live" while polling, "Updates paused" when the
// tab is hidden, "Data may be stale" after repeated refresh failures, with an
// "Updated Ns ago" note that ticks each second.
function LiveIndicator({ status }: { status: MonitorLiveStatus }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const label = status.isStale
    ? "Data may be stale"
    : status.isPaused
      ? "Updates paused"
      : "Live";
  const dotClass = status.isStale
    ? "bg-[var(--down)]"
    : status.isPaused
      ? "bg-[var(--neutral-state)]"
      : "bg-[var(--up)]";
  const secondsAgo =
    status.updatedAt === null ? null : Math.round((now - status.updatedAt) / 1_000);

  return (
    <span
      className="inline-flex items-center gap-1.5 font-data text-[11px] text-[var(--fg-muted)]"
      aria-live="polite"
    >
      <span className={cn("size-1.5 rounded-full", dotClass)} aria-hidden />
      {label}
      {secondsAgo !== null && !status.isPaused ? (
        <span className="text-[var(--fg-faint)]">· {formatUpdatedAgo(secondsAgo)}</span>
      ) : null}
    </span>
  );
}

function EmptyCardContent({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-28 items-center justify-center text-[13px] text-[var(--fg-muted)]">
      {children}
    </div>
  );
}

function UptimeStat({
  label,
  unlocked,
  value,
  coverage,
  tone,
}: {
  label: string;
  unlocked: boolean;
  value: number | null;
  coverage: number | null;
  tone: UptimeTone;
}) {
  return (
    <Card className="min-w-0">
      <CardContent>
        <p className="text-xs text-[var(--fg-muted)]">{label}</p>
        {unlocked ? (
          <>
            <p className={cn("mt-2 font-data text-xl", toneClass[tone])}>
              {formatUptimeDetail(value)}
            </p>
            <p className="mt-1 font-data text-xs text-[var(--fg-muted)]">
              Coverage {formatCoverage(coverage)}
            </p>
          </>
        ) : (
          <p className="mt-2 text-[13px] text-[var(--fg-muted)]">Collecting data</p>
        )}
      </CardContent>
    </Card>
  );
}

function ObservedUptimeStat({
  firstRun,
  tone,
}: {
  firstRun: MonitorDetailData["firstRun"];
  tone: UptimeTone;
}) {
  return (
    <Card className="min-w-0">
      <CardContent>
        <p className="text-xs text-[var(--fg-muted)]">Observed uptime</p>
        <p className={cn("mt-2 font-data text-xl", toneClass[tone])}>
          {formatUptimeDetail(firstRun.observed.uptime)}
        </p>
        <p className="mt-1 text-xs text-[var(--fg-muted)]">
          Since monitoring began · {formatDuration(firstRun.observedSeconds)} observed
        </p>
        <p className="mt-1 font-data text-xs text-[var(--fg-muted)]">
          {firstRun.observed.completed} of {firstRun.observed.expected} checks
        </p>
      </CardContent>
    </Card>
  );
}

function SetupStat() {
  return (
    <Card className="min-w-0">
      <CardContent>
        <p className="text-xs text-[var(--fg-muted)]">Status</p>
        <p className="mt-2 text-xl">Verifying setup</p>
        <p className="mt-1 text-xs text-[var(--fg-muted)]">
          Monitoring begins at the first successful check
        </p>
      </CardContent>
    </Card>
  );
}

export function MonitorDetail({ monitor: snapshot }: { monitor: MonitorDetailData }) {
  const { resolvedTimeZone } = useTimezone();
  const live = useMonitorLive(snapshot.id, {
    phase: snapshot.firstRun.phase,
    state: snapshot.state,
    rollupVersion: snapshot.rollupVersion,
  });
  // Merge the polled fields over the snapshot in place. Charts, timeline
  // buckets, and configuration stay on the snapshot until a rollup refresh
  // advances them through router.refresh. Uptime and coverage merge per range,
  // so the d30 and d90 values the live payload omits fall back to the snapshot.
  const monitor: MonitorDetailData = live.data
    ? {
        ...snapshot,
        ...live.data,
        uptime: { ...snapshot.uptime, ...live.data.uptime },
        coverage: { ...snapshot.coverage, ...live.data.coverage },
      }
    : snapshot;
  const [availabilityRange, setAvailabilityRange] =
    useState<AvailabilityRange>("h24");
  const [responseRange, setResponseRange] = useState<ResponseRange>("h24");
  const availability = monitor.availability[availabilityRange];
  const responseTime = monitor.responseTime[responseRange];
  const { phase } = monitor.firstRun;
  // Red is reserved for the present. An ongoing incident or a down state is
  // the only thing that turns an uptime figure red. A recently resolved
  // incident degrades it to amber instead.
  const currentlyDown =
    monitor.state === "DOWN" || monitor.latestIncident?.state === "ONGOING";
  const recentlyDegraded = monitor.latestIncident?.state === "RESOLVED";
  const toneFor = (range: AvailabilityRange): UptimeTone =>
    uptimeTone({
      unlocked: monitor.rangeUnlocked[range],
      currentlyDown,
      recentlyDegraded,
      uptime: monitor.uptime[range],
    });
  const availabilityUnlocked = monitor.rangeUnlocked[availabilityRange];

  return (
    <div className="space-y-6">
      <header>
        <Link
          href="/"
          className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Overview
        </Link>
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-semibold tracking-[-0.02em]">
                {monitor.name}
              </h1>
              <StatusBadge state={monitor.state} />
              <LiveIndicator status={live} />
            </div>
            <div className="mt-2 flex min-w-0 items-center gap-2 font-data text-[13px] text-[var(--fg-muted)]">
              <span className="rounded bg-[var(--chip-bg)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--fg)]">
                {monitor.method}
              </span>
              <a
                href={monitor.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 truncate hover:text-[var(--fg)] hover:underline"
                title={monitor.url}
              >
                {monitor.url}
              </a>
              <ExternalLink className="size-3 shrink-0" aria-hidden />
            </div>
          </div>
          <MonitorActions monitor={monitor} />
        </div>
      </header>

      <section className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3" aria-label="Monitor statistics">
        <Card className="min-w-0">
          <CardContent>
            <p className="text-xs text-[var(--fg-muted)]">Latest Latency</p>
            <p className="mt-2 font-data text-xl">
              {formatLatency(monitor.latestLatencyMs)}
            </p>
            <p className="mt-1 font-data text-xs text-[var(--fg-muted)]">
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
                key={range}
                label={`Uptime ${availabilityRanges.find((entry) => entry.key === range)?.label}`}
                unlocked={monitor.rangeUnlocked[range]}
                value={monitor.uptime[range]}
                coverage={monitor.coverage[range]}
                tone={toneFor(range)}
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
              ? `The last check failed with ${monitor.firstRun.setupError}. Setup failures are warnings, not incidents. Fix the endpoint and run a test, or edit the configuration.`
              : "Monitoring officially begins after the first successful check. No incidents or downtime are recorded during setup."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <MonitorRunTestButton monitor={monitor} />
            <MonitorEditButton monitor={monitor} />
          </div>
        </div>
      ) : null}

      {monitor.latestIncident ? (
        <Link
          href={`/incidents/${encodeURIComponent(monitor.latestIncident.id)}`}
          className={cn(
            "flex flex-col justify-between gap-2 rounded-xl border p-4 text-[13px] transition-colors hover:border-[var(--border-hover)] sm:flex-row sm:items-center",
            monitor.latestIncident.state === "ONGOING"
              ? "border-[var(--down-border)] bg-[var(--down-bg)]"
              : "border-[var(--border)] bg-[var(--bg)]",
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <StatusDot
              state={monitor.latestIncident.state === "ONGOING" ? "DOWN" : "UP"}
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
            {formatTimestamp(monitor.latestIncident.openedAt, resolvedTimeZone)} ·{" "}
            {formatDuration(monitor.latestIncident.durationSeconds)}
          </span>
        </Link>
      ) : null}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Availability</CardTitle>
            {availabilityUnlocked ? (
              <p className={cn("mt-1 font-data text-[13px]", toneClass[toneFor(availabilityRange)])}>
                {formatUptimeDetail(monitor.uptime[availabilityRange])}
                <span className="ml-2 text-[var(--fg-muted)]">
                  Coverage {formatCoverage(monitor.coverage[availabilityRange])}
                </span>
              </p>
            ) : (
              <p className="mt-1 text-[13px] text-[var(--fg-muted)]">Collecting data</p>
            )}
          </div>
          <RangeButtons
            ranges={availabilityRanges}
            value={availabilityRange}
            onChange={setAvailabilityRange}
            label="Availability range"
          />
        </CardHeader>
        <CardContent>
          {availability.buckets.length ? (
            <>
              <TimelineBar
                buckets={availability.buckets}
                height={32}
                label={`${availabilityRanges.find((range) => range.key === availabilityRange)?.label} availability`}
              />
              <div className="mt-2 flex justify-between font-data text-[11px] text-[var(--fg-faint)]">
                <span>{formatTimestamp(availability.start, resolvedTimeZone)}</span>
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
            ranges={responseRanges}
            value={responseRange}
            onChange={setResponseRange}
            label="Response time range"
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
            <Link
              href={`/incidents?monitor=${encodeURIComponent(monitor.id)}`}
              className={buttonVariants({ variant: "tertiary", size: "sm" })}
            >
              View All
            </Link>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {monitor.recentIncidents.length ? (
              <div className="hide-scrollbar overflow-x-auto">
                <table className="w-full min-w-[580px] border-collapse text-left text-[13px]">
                  <thead className="text-xs text-[var(--fg-muted)]">
                    <tr className="h-10 border-y border-[var(--border)]">
                      <th className="px-6 font-medium">Started</th>
                      <th className="px-4 font-medium">Duration</th>
                      <th className="px-6 font-medium">Opening Failure</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monitor.recentIncidents.map((incident) => (
                      <tr key={incident.id} className="h-12 border-b border-[var(--border)] last:border-0 hover:bg-[var(--hover)]">
                        <td className="px-6 font-data whitespace-nowrap">
                          <Link href={`/incidents/${encodeURIComponent(incident.id)}`} className="hover:underline">
                            {formatTimestamp(incident.openedAt, resolvedTimeZone)}
                          </Link>
                        </td>
                        <td className="px-4 font-data whitespace-nowrap">
                          {formatDuration(incident.durationSeconds)}
                        </td>
                        <td className="max-w-64 truncate px-6 font-data" title={incident.openingFailure}>
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
                  <thead className="text-xs text-[var(--fg-muted)]">
                    <tr className="h-10 border-y border-[var(--border)]">
                      <th className="px-6 font-medium">Time</th>
                      <th className="px-4 font-medium">Result</th>
                      <th className="px-6 text-right font-medium">Latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monitor.recentChecks.map((check) => (
                      <tr
                        key={check.id}
                        className={cn(
                          "h-12 border-b border-[var(--border)] last:border-0",
                          !check.successful && "bg-[color-mix(in_srgb,var(--down-bg)_40%,transparent)]",
                        )}
                      >
                        <td className="px-6 font-data whitespace-nowrap">
                          {formatTimestamp(check.checkedAt, resolvedTimeZone)}
                        </td>
                        <td className={cn("px-4 font-data", !check.successful && "text-[var(--down-text)]")}>
                          <span className="inline-flex items-center gap-2 whitespace-nowrap">
                            <span
                              className={cn(
                                "size-1.5 rounded-full",
                                check.successful ? "bg-[var(--up)]" : "bg-[var(--down)]",
                              )}
                              aria-hidden
                            />
                            {check.resultLabel}
                          </span>
                        </td>
                        <td className="px-6 text-right font-data whitespace-nowrap">
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

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4">
          <CardTitle>Configuration</CardTitle>
          <MonitorEditButton monitor={monitor} />
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
            <ConfigurationField label="Method" value={monitor.method} />
            <ConfigurationField label="Interval" value={formatInterval(monitor.intervalSeconds)} />
            <ConfigurationField label="Timeout" value={`${monitor.timeoutSeconds}s`} />
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
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function ConfigurationField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-[var(--fg-muted)]">{label}</dt>
      <dd className="mt-1 font-data text-[13px]">{value}</dd>
    </div>
  );
}
