import "server-only"

import { sql } from "@/lib/db/client"
import { portableQueryValues } from "@/lib/db/query-values"
import {
  GOVERNOR_ACTIONS,
  type GovernorMode,
  retentionFor,
} from "@/lib/storage/governor"
import { MEASURE_USAGE_SQL } from "@/lib/storage/sql"

import type {
  AttributedDatabaseCategoryKey,
  DatabaseGovernorMode,
  DatabaseHealthCategoryKey,
  DatabaseHealthMeasurement,
  DatabaseHealthRepository,
} from "./types"
import { DATABASE_STORAGE_BUDGET_BYTES } from "./types"

type RuntimeDate = Date | string | number

interface SnapshotRow {
  captured_at: RuntimeDate
  storage_bytes: bigint | string
  index_bytes: bigint | string
  category_bytes: Record<string, bigint | number | string> | string
  history_bytes: bigint | string | null
  monthly_transfer_bytes: bigint | string | null
  projected_30_day_bytes: bigint | string
  governor_mode: string
  last_compaction_at: RuntimeDate | null
  scheduler_coverage: number | string | null
  provider_metrics_captured_at: RuntimeDate | null
  maintenance_status: string | null
}

interface RetentionRow {
  key: string
  label: string
  configured_seconds: number | string | null
  oldest_at: RuntimeDate | null
}

const RETENTION_AGES_SQL = `
select 'minute' key, 'Recent checks' label, 172800 configured_seconds, min(scheduled_minute) oldest_at from check_batches
union all select '15m', '15-minute rollups', 604800, min(bucket_start) from metric_rollups where resolution = '15m'
union all select 'hour', 'Hourly rollups', 2592000, min(bucket_start) from metric_rollups where resolution = 'hour'
union all select 'day', 'Daily rollups', 63072000, min(bucket_start) from metric_rollups where resolution = 'day'
union all select 'exceptions', 'Exception history', 63072000, min(first_seen_at) from monitor_exceptions
union all select 'payloads', 'Exception details', 2592000, min(created_at) from exception_payloads
`

const LATEST_SNAPSHOT_SQL = `
select snapshot.*,
  (select status from cron_runs where job_name = 'maintenance' order by started_at desc limit 1) maintenance_status
from database_usage_snapshots snapshot order by captured_at desc limit 1
`

function finiteNumber(
  value: bigint | number | string | null | undefined
): number | null {
  if (value === null || value === undefined) {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function finiteDate(value: RuntimeDate | null | undefined): Date | null {
  if (value === null || value === undefined) {
    return null
  }
  try {
    const isoValue =
      Object.prototype.toString.call(value) === "[object Date]"
        ? (value as Date).toISOString()
        : value
    const date = new Date(isoValue)
    return Number.isFinite(date.valueOf()) ? date : null
  } catch {
    return null
  }
}

function categoryRecord(
  value: SnapshotRow["category_bytes"]
): Record<string, bigint | number | string> {
  if (typeof value !== "string") {
    return value ?? {}
  }
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, bigint | number | string>)
      : {}
  } catch {
    return {}
  }
}

function publicGovernorMode(value: string): DatabaseGovernorMode {
  return (
    (
      {
        full: "FULL_DETAIL",
        compact_early: "EARLY_COMPACTION",
        shortened: "SHORTENED_RETENTION",
        incident_only: "INCIDENT_HOURLY_ONLY",
        essential: "ESSENTIALS_ONLY",
      } as const
    )[value as "full"] ?? "UNKNOWN"
  )
}

function governorAction(mode: DatabaseGovernorMode): string | null {
  return mode === "UNKNOWN" ? null : GOVERNOR_ACTIONS[mode]
}

function projectMonthlyTransfer(
  usedBytes: number | null,
  capturedAt: Date
): number | null {
  if (usedBytes === null) {
    return null
  }
  const elapsedDays = Math.max(1, capturedAt.getUTCDate())
  const daysInMonth = new Date(
    Date.UTC(capturedAt.getUTCFullYear(), capturedAt.getUTCMonth() + 1, 0)
  ).getUTCDate()
  return Math.round((usedBytes * daysInMonth) / elapsedDays)
}

async function readLatest(): Promise<DatabaseHealthMeasurement | null> {
  const rows = (await sql.unsafe(
    LATEST_SNAPSHOT_SQL
  )) as unknown as SnapshotRow[]
  const snapshot = rows[0]
  if (!snapshot) {
    return null
  }
  const capturedAt = finiteDate(snapshot.captured_at)
  if (!capturedAt) {
    throw new Error("Invalid database usage snapshot timestamp")
  }
  const retention = (await sql.unsafe(
    RETENTION_AGES_SQL
  )) as unknown as RetentionRow[]
  const rawCategories = categoryRecord(snapshot.category_bytes)
  const allowedCategories = new Set<DatabaseHealthCategoryKey>([
    "recentCheckBatches",
    "rollups",
    "exceptions",
    "incidents",
    "coreData",
    "operations",
    "content",
    "indexes",
    "other",
  ])
  const categoryBytes = Object.fromEntries(
    Object.entries(rawCategories)
      .filter(
        ([key]) =>
          key !== "other" &&
          allowedCategories.has(key as DatabaseHealthCategoryKey)
      )
      .map(([key, value]) => [key, finiteNumber(value) ?? 0])
  ) as Partial<Record<AttributedDatabaseCategoryKey, number>>
  categoryBytes.indexes ??= finiteNumber(snapshot.index_bytes) ?? 0
  const persistedOtherBytes =
    finiteNumber(rawCategories.other) ??
    finiteNumber(snapshot.history_bytes) ??
    0
  const relationStorageBytes = finiteNumber(snapshot.storage_bytes)
  const providerStorageBytes =
    relationStorageBytes === null
      ? null
      : relationStorageBytes + persistedOtherBytes
  const governorMode = publicGovernorMode(snapshot.governor_mode)
  const monthlyTransferBytes = finiteNumber(snapshot.monthly_transfer_bytes)
  const providerMetricsCapturedAt = finiteDate(
    snapshot.provider_metrics_captured_at
  )
  return {
    capturedAt,
    storageBytes: providerStorageBytes,
    otherBytes: persistedOtherBytes,
    projected30DayBytes:
      finiteNumber(snapshot.projected_30_day_bytes) === null
        ? null
        : finiteNumber(snapshot.projected_30_day_bytes)! + persistedOtherBytes,
    categoryBytes,
    retention: retention.map((row) => ({
      key: row.key,
      label: row.label,
      configuredSeconds: effectiveRetentionSeconds(
        row.key,
        governorMode,
        finiteNumber(row.configured_seconds)
      ),
      oldestAt: finiteDate(row.oldest_at),
    })),
    governorMode,
    governorAction: governorAction(governorMode),
    lastCompactionAt: finiteDate(snapshot.last_compaction_at),
    schedulerCoverage: finiteNumber(snapshot.scheduler_coverage),
    monthlyTransferBytes,
    projectedMonthlyTransferBytes: projectMonthlyTransfer(
      monthlyTransferBytes,
      capturedAt
    ),
    providerMetricsAvailable: providerMetricsCapturedAt !== null,
    providerMetricsCapturedAt,
    maintenanceHealthy:
      snapshot.maintenance_status === "completed"
        ? true
        : snapshot.maintenance_status === "failed"
          ? false
          : null,
  }
}

const INTERNAL_GOVERNOR_MODE: Partial<
  Record<DatabaseGovernorMode, GovernorMode>
> = {
  FULL_DETAIL: "full",
  EARLY_COMPACTION: "compact_early",
  SHORTENED_RETENTION: "shortened",
  INCIDENT_HOURLY_ONLY: "incident_only",
  ESSENTIALS_ONLY: "essential",
}

// The minute, 15-minute, and hourly ladders are owned by governor.retentionFor.
// Keys outside that ladder, and an unknown mode, fall back to the configured
// ages carried by RETENTION_AGES_SQL.
function effectiveRetentionSeconds(
  key: string,
  mode: DatabaseGovernorMode,
  fallback: number | null
): number | null {
  const internal = INTERNAL_GOVERNOR_MODE[mode]
  if (!internal) {
    return fallback
  }
  const policy = retentionFor(internal)
  switch (key) {
    case "minute":
      return policy.minuteHours * 3600
    case "15m":
      return policy.quarterHourDays * 86_400
    case "hour":
      return policy.hourlyDays * 86_400
    default:
      return fallback
  }
}

/**
 * Reads daily snapshots cheaply; capture performs the physical allocation scan
 * server-side and then returns the normalized stored result.
 */
export const databaseHealthRepository: DatabaseHealthRepository = {
  async readLatest() {
    return readLatest()
  },
  async capture() {
    const now = new Date()
    await sql.unsafe(
      MEASURE_USAGE_SQL,
      portableQueryValues([
        now,
        DATABASE_STORAGE_BUDGET_BYTES,
        null,
        null,
        null,
      ]) as never[]
    )
    return readLatest()
  },
}
