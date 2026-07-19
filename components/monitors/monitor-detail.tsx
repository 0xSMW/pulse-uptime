"use client";

import { ArrowLeft, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import type { LatencyPoint } from "@/components/charts/latency-chart";
import { LazyLatencyChart } from "@/components/charts/lazy-latency-chart";
import { useTimezone } from "@/components/dashboard/timezone-provider";
import { DependencyOverlapCard } from "@/components/dependencies/dependency-overlap-card";
import type { DependencyIncidentOverlap } from "@/components/incidents/types";
import { StatusBadge } from "@/components/monitors/status-badge";
import { MonitorActions, MonitorEditButton } from "@/components/monitors/monitor-actions";
import { StatusDot, type MonitorState } from "@/components/monitors/status-dot";
import { TimelineBar, type TimelineBucket } from "@/components/monitors/timeline-bar";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatDuration,
  formatLatency,
  formatUptimeDetail,
} from "@/lib/reporting/format";
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
  p95LatencyMs: number | null;
  uptime: Record<AvailabilityRange, number | null>;
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
    overlaps: DependencyIncidentOverlap[];
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

function uptimeTone(value: number | null): string {
  if (value === null) return "text-[var(--fg-muted)]";
  if (value < 99) return "text-[var(--down-text)]";
  if (value < 99.9) return "text-[var(--verifying-text)]";
  return "text-[var(--fg)]";
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

function EmptyCardContent({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-28 items-center justify-center text-[13px] text-[var(--fg-muted)]">
      {children}
    </div>
  );
}

function UptimeStat({ label, value }: { label: string; value: number | null }) {
  return (
    <Card className="min-w-0">
      <CardContent>
        <p className="text-xs text-[var(--fg-muted)]">{label}</p>
        <p className={cn("mt-2 font-data text-xl", uptimeTone(value))}>
          {formatUptimeDetail(value)}
        </p>
      </CardContent>
    </Card>
  );
}

export function MonitorDetail({ monitor }: { monitor: MonitorDetailData }) {
  const { resolvedTimeZone } = useTimezone();
  const [availabilityRange, setAvailabilityRange] =
    useState<AvailabilityRange>("h24");
  const [responseRange, setResponseRange] = useState<ResponseRange>("h24");
  const availability = monitor.availability[availabilityRange];
  const responseTime = monitor.responseTime[responseRange];

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
        <UptimeStat label="Uptime 24h" value={monitor.uptime.h24} />
        <UptimeStat label="Uptime 7d" value={monitor.uptime.d7} />
        <UptimeStat label="Uptime 30d" value={monitor.uptime.d30} />
      </section>

      {monitor.latestIncident ? (
        <>
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
          <DependencyOverlapCard overlaps={monitor.latestIncident.overlaps} />
        </>
      ) : null}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Availability</CardTitle>
            <p className={cn("mt-1 font-data text-[13px]", uptimeTone(monitor.uptime[availabilityRange]))}>
              {formatUptimeDetail(monitor.uptime[availabilityRange])}
            </p>
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
