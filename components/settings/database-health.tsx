"use client"

import { useState } from "react"

import { useTimezone } from "@/components/dashboard/timezone-provider"
import {
  type ApiEnvelope,
  apiRequest,
  messageForError,
} from "@/components/settings/settings-api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type {
  DatabaseHealth,
  DatabaseHealthState,
} from "@/lib/database-health/types"
import { cn } from "@/lib/utils"

const stateStyles: Record<DatabaseHealthState, string> = {
  HEALTHY: "bg-[var(--up-bg)] text-[var(--up-text)]",
  WATCHING: "bg-[var(--verifying-bg)] text-[var(--verifying-text)]",
  OPTIMIZING: "bg-[var(--verifying-bg)] text-[var(--verifying-text)]",
  PROTECTING: "bg-[var(--verifying-bg)] text-[var(--verifying-text)]",
  CRITICAL: "bg-[var(--down-bg)] text-[var(--down-text)]",
  UNKNOWN: "bg-[var(--chip-bg)] text-[var(--fg-muted)]",
}

const governorLabels: Record<DatabaseHealth["governor"]["mode"], string> = {
  FULL_DETAIL: "Full detail",
  EARLY_COMPACTION: "Early compaction",
  SHORTENED_RETENTION: "Shorter retention",
  INCIDENT_HOURLY_ONLY: "Incident-hourly only",
  ESSENTIALS_ONLY: "Essential data only",
  UNKNOWN: "Unknown",
}

export function formatDatabaseBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "Unavailable"
  }
  if (value < 1000) {
    return `${Math.round(value)} B`
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1000)} KB`
  }
  if (value < 1_000_000_000) {
    return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value / 1_000_000)} MB`
  }
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value / 1_000_000_000)} GB`
}

export function formatRetention(seconds: number | null): string {
  if (seconds === null) {
    return "Adaptive"
  }
  const units = [
    [31_536_000, "year"],
    [86_400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ] as const
  const [divisor, label] = units.find(([unit]) => seconds >= unit) ?? [
    1,
    "second",
  ]
  const amount = Math.max(0, Math.round(seconds / divisor))
  return `${amount} ${label}${amount === 1 ? "" : "s"}`
}

function formatDate(value: string | null, timeZone: string): string {
  if (!value) {
    return "Never"
  }
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) {
    return "Unavailable"
  }
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
    hour12: false,
    timeZoneName: "short",
  })
    .format(date)
    .replace(",", "")
}

function formatOldest(value: string | null): string {
  if (!value) {
    return "No data"
  }
  const elapsed = Date.now() - new Date(value).valueOf()
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return "Unavailable"
  }
  return `${formatRetention(Math.round(elapsed / 1000))} ago`
}

function percentage(value: number | null, total: number): number {
  if (value === null || total <= 0) {
    return 0
  }
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)))
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-semibold text-[11px] text-[var(--fg-faint)] uppercase tracking-[0.08em]">
      {children}
    </h3>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[var(--fg-muted)] text-xs">{label}</dt>
      <dd className="mt-1 font-data text-[13px]">{value}</dd>
    </div>
  )
}

function EmptyDatabaseHealth({
  onRefresh,
  busy,
  status,
  loadFailed,
}: {
  onRefresh: () => void
  busy: boolean
  status: string
  loadFailed: boolean
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-4">
        <CardTitle>Database Health</CardTitle>
        <span
          className={cn(
            "rounded-full px-2 py-1 font-medium text-xs",
            stateStyles.UNKNOWN
          )}
        >
          Unknown
        </span>
      </CardHeader>
      <CardContent>
        <div
          className="rounded-[8px] border border-[var(--border-strong)] border-dashed px-4 py-8 text-center"
          role={loadFailed ? "alert" : undefined}
        >
          <p className="font-medium">
            {loadFailed
              ? "Database health unavailable"
              : "No usage snapshot yet"}
          </p>
          <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
            {loadFailed
              ? "Refresh to retry the measurement"
              : "Measure database usage to begin"}
          </p>
          <Button
            className="mt-4"
            disabled={busy}
            onClick={onRefresh}
            variant="secondary"
          >
            {busy ? "Refreshing…" : "Refresh"}
          </Button>
          {status ? (
            <p className="mt-3 text-[13px] text-[var(--fg-muted)]" role="alert">
              {status}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

export function DatabaseHealthCard({
  initialData,
  initialError = false,
}: {
  initialData: DatabaseHealth | null
  initialError?: boolean
}) {
  const { resolvedTimeZone } = useTimezone()
  const [data, setData] = useState(initialData)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("")

  async function refresh() {
    setBusy(true)
    setStatus("")
    try {
      const response = await apiRequest<ApiEnvelope<DatabaseHealth>>(
        "/api/v1/database-health/refresh",
        { method: "POST" },
        { mutation: true }
      )
      setData(response.data)
      setStatus(
        response.data.refresh.status === "STALE_FALLBACK"
          ? "Refresh failed, showing the last measurement"
          : response.data.refresh.cached
            ? "Showing a recent measurement"
            : "Database metrics refreshed"
      )
    } catch (error) {
      setStatus(messageForError(error))
    } finally {
      setBusy(false)
    }
  }

  if (!data) {
    return (
      <EmptyDatabaseHealth
        busy={busy}
        loadFailed={initialError}
        onRefresh={refresh}
        status={status}
      />
    )
  }
  const usedPercent = percentage(data.usedBytes, data.budgetBytes)
  const freshness = data.freshness.capturedAt
    ? `Updated ${formatDate(data.freshness.capturedAt, resolvedTimeZone)}`
    : "Update time unavailable"

  return (
    <Card aria-busy={busy} className="overflow-hidden">
      <CardHeader className="flex-row items-start justify-between gap-4 p-6 pb-4">
        <div>
          <CardTitle>Database Health</CardTitle>
          <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
            {data.summary}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-1 font-medium text-xs",
            stateStyles[data.health]
          )}
        >
          {data.health[0] + data.health.slice(1).toLowerCase()}
        </span>
      </CardHeader>
      <CardContent className="space-y-7 border-[var(--border)] border-t pt-5">
        <section
          aria-labelledby="database-storage-heading"
          className="space-y-3"
        >
          <SectionTitle>
            <span id="database-storage-heading">Storage</span>
          </SectionTitle>
          <p className="font-data font-medium text-lg">
            {formatDatabaseBytes(data.usedBytes)} of{" "}
            {formatDatabaseBytes(data.budgetBytes)}
          </p>
          <div
            aria-label="Database storage used"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={data.usedBytes === null ? undefined : usedPercent}
            aria-valuetext={
              data.usedBytes === null
                ? "Storage usage unavailable"
                : `${usedPercent}% used`
            }
            className="h-2 overflow-hidden rounded-full bg-[var(--chip-bg)]"
            role="progressbar"
          >
            <div
              className="h-full rounded-full bg-[var(--fg-muted)]"
              style={{ width: `${usedPercent}%` }}
            />
          </div>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Metric
              label="Projected in 30 days"
              value={formatDatabaseBytes(data.projected30DayBytes)}
            />
            <Metric
              label="Available"
              value={formatDatabaseBytes(data.availableBytes)}
            />
          </dl>
        </section>

        <section
          aria-labelledby="database-breakdown-heading"
          className="space-y-3"
        >
          <SectionTitle>
            <span id="database-breakdown-heading">Data Breakdown</span>
          </SectionTitle>
          <ul className="divide-y divide-[var(--border)]">
            {data.categories.map((category) => {
              const share = percentage(category.bytes, data.usedBytes ?? 0)
              return (
                <li
                  className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 py-2.5 sm:grid-cols-[minmax(150px,1fr)_auto_minmax(120px,1fr)_3rem]"
                  key={category.key}
                >
                  <span className="text-[13px]">{category.label}</span>
                  <span className="font-data text-[var(--fg-muted)] text-xs">
                    {formatDatabaseBytes(category.bytes)}
                  </span>
                  <div className="col-span-2 h-1.5 overflow-hidden rounded-full bg-[var(--chip-bg)] sm:col-span-1">
                    <div
                      className="h-full bg-[var(--fg-muted)]"
                      style={{ width: `${share}%` }}
                    />
                  </div>
                  <span className="hidden text-right font-data text-[var(--fg-faint)] text-xs sm:block">
                    {share}%
                  </span>
                </li>
              )
            })}
          </ul>
        </section>

        <section
          aria-labelledby="database-retention-heading"
          className="space-y-3"
        >
          <SectionTitle>
            <span id="database-retention-heading">Retention</span>
          </SectionTitle>
          {data.retention.length ? (
            <dl className="divide-y divide-[var(--border)]">
              {data.retention.map((item) => (
                <div
                  className="grid grid-cols-1 gap-1 py-2.5 text-[13px] sm:grid-cols-[1fr_auto_auto] sm:gap-6"
                  key={item.key}
                >
                  <dt>{item.label}</dt>
                  <dd className="font-data text-[var(--fg-muted)]">
                    {formatRetention(item.configuredSeconds)}
                  </dd>
                  <dd className="font-data text-[var(--fg-faint)]">
                    Oldest {formatOldest(item.oldestAt)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-[13px] text-[var(--fg-muted)]">
              Retention ages unavailable
            </p>
          )}
        </section>

        <section
          aria-labelledby="database-management-heading"
          className="space-y-3"
        >
          <SectionTitle>
            <span id="database-management-heading">Automatic Management</span>
          </SectionTitle>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Metric label="Mode" value={governorLabels[data.governor.mode]} />
            <Metric
              label="Last compacted"
              value={formatDate(
                data.governor.lastCompactionAt,
                resolvedTimeZone
              )}
            />
            <Metric
              label="Scheduler coverage"
              value={
                data.schedulerCoverage === null
                  ? "Unavailable"
                  : `${(data.schedulerCoverage * 100).toFixed(2)}%`
              }
            />
            <Metric label="Current behavior" value={data.governor.action} />
          </dl>
        </section>

        <section
          aria-labelledby="database-network-heading"
          className="space-y-3"
        >
          <SectionTitle>
            <span id="database-network-heading">Network</span>
          </SectionTitle>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Metric
              label="This month"
              value={`${formatDatabaseBytes(data.transfer.usedBytes)} of ${formatDatabaseBytes(data.transfer.budgetBytes)}`}
            />
            <Metric
              label="Projected this month"
              value={formatDatabaseBytes(data.transfer.projectedBytes)}
            />
          </dl>
          {data.freshness.providerMetricsAvailable ? (
            data.freshness.providerCapturedAt ? (
              <p className="font-data text-[var(--fg-faint)] text-xs">
                Provider updated{" "}
                {formatDate(
                  data.freshness.providerCapturedAt,
                  resolvedTimeZone
                )}
              </p>
            ) : null
          ) : (
            <p className="text-[13px] text-[var(--fg-muted)]">
              Provider transfer metrics are not collected on this deployment,
              relation usage remains current
            </p>
          )}
        </section>

        <div className="-mx-6 space-y-3 border-[var(--border)] border-t px-6 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-data text-[var(--fg-muted)] text-xs">
                {freshness}
              </p>
              {data.freshness.stale ? (
                <p className="mt-1 text-[var(--fg-muted)] text-xs">
                  Metrics are stale
                </p>
              ) : null}
            </div>
            <Button
              disabled={busy}
              onClick={refresh}
              size="sm"
              variant="secondary"
            >
              {busy ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
          <p
            aria-live="polite"
            className="min-h-5 text-[13px] text-[var(--fg-muted)]"
          >
            {status}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
