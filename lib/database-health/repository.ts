import "server-only";

import { sql } from "@/lib/db/client";
import { STORAGE_BUDGET_BYTES } from "@/lib/storage/governor";
import { MEASURE_USAGE_SQL } from "@/lib/storage/sql";

import type {
  AttributedDatabaseCategoryKey,
  DatabaseGovernorMode,
  DatabaseHealthMeasurement,
  DatabaseHealthRepository,
} from "./types";

type SnapshotRow = {
  captured_at: Date;
  storage_bytes: bigint | string;
  category_bytes: Record<string, bigint | number | string>;
  monthly_transfer_bytes: bigint | string | null;
  projected_30_day_bytes: bigint | string;
  governor_mode: string;
  last_compaction_at: Date | null;
  scheduler_coverage: number | string | null;
  provider_metrics_captured_at: Date | null;
  maintenance_status: string | null;
};

type RetentionRow = {
  key: string;
  label: string;
  configured_seconds: number | string | null;
  oldest_at: Date | null;
};

const RETENTION_AGES_SQL = `
select 'minute' key, 'Recent checks' label, 172800 configured_seconds, min(scheduled_minute) oldest_at from check_batches
union all select '15m', '15-minute rollups', 604800, min(bucket_start) from metric_rollups where resolution = '15m'
union all select 'hour', 'Hourly rollups', 2592000, min(bucket_start) from metric_rollups where resolution = 'hour'
union all select 'day', 'Daily rollups', 63072000, min(bucket_start) from metric_rollups where resolution = 'day'
union all select 'exceptions', 'Exception history', 63072000, min(first_seen_at) from monitor_exceptions
union all select 'payloads', 'Exception details', 2592000, min(created_at) from exception_payloads
`;

const LATEST_SNAPSHOT_SQL = `
select snapshot.*,
  (select status from cron_runs where job_name = 'maintenance' order by started_at desc limit 1) maintenance_status
from database_usage_snapshots snapshot order by captured_at desc limit 1
`;

function finiteNumber(value: bigint | number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function publicGovernorMode(value: string): DatabaseGovernorMode {
  return ({
    full: "FULL_DETAIL",
    compact_early: "EARLY_COMPACTION",
    shortened: "SHORTENED_RETENTION",
    incident_only: "INCIDENT_HOURLY_ONLY",
    essential: "ESSENTIALS_ONLY",
  } as const)[value as "full"] ?? "UNKNOWN";
}

function governorAction(mode: DatabaseGovernorMode): string | null {
  switch (mode) {
    case "FULL_DETAIL": return "Full configured detail is retained";
    case "EARLY_COMPACTION": return "Completed buckets are compacted early";
    case "SHORTENED_RETENTION": return "Minute and 15-minute retention is shorter";
    case "INCIDENT_HOURLY_ONLY": return "Hourly detail is retained around incidents";
    case "ESSENTIALS_ONLY": return "Current state, incidents, and daily uptime are preserved";
    case "UNKNOWN": return null;
  }
}

function projectMonthlyTransfer(usedBytes: number | null, capturedAt: Date): number | null {
  if (usedBytes === null) return null;
  const elapsedDays = Math.max(1, capturedAt.getUTCDate());
  const daysInMonth = new Date(Date.UTC(capturedAt.getUTCFullYear(), capturedAt.getUTCMonth() + 1, 0)).getUTCDate();
  return Math.round(usedBytes * daysInMonth / elapsedDays);
}

async function readLatest(): Promise<DatabaseHealthMeasurement | null> {
  const rows = await sql.unsafe(LATEST_SNAPSHOT_SQL) as unknown as SnapshotRow[];
  const snapshot = rows[0];
  if (!snapshot) return null;
  const retention = await sql.unsafe(RETENTION_AGES_SQL) as unknown as RetentionRow[];
  const categoryBytes = Object.fromEntries(Object.entries(snapshot.category_bytes ?? {})
    .filter(([key]) => key !== "other")
    .map(([key, value]) => [key, finiteNumber(value) ?? 0])) as Partial<Record<AttributedDatabaseCategoryKey, number>>;
  const governorMode = publicGovernorMode(snapshot.governor_mode);
  const monthlyTransferBytes = finiteNumber(snapshot.monthly_transfer_bytes);
  return {
    capturedAt: snapshot.captured_at,
    storageBytes: finiteNumber(snapshot.storage_bytes),
    projected30DayBytes: finiteNumber(snapshot.projected_30_day_bytes),
    categoryBytes,
    retention: retention.map((row) => ({
      key: row.key,
      label: row.label,
      configuredSeconds: finiteNumber(row.configured_seconds),
      oldestAt: row.oldest_at,
    })),
    governorMode,
    governorAction: governorAction(governorMode),
    lastCompactionAt: snapshot.last_compaction_at,
    schedulerCoverage: finiteNumber(snapshot.scheduler_coverage),
    monthlyTransferBytes,
    projectedMonthlyTransferBytes: projectMonthlyTransfer(monthlyTransferBytes, snapshot.captured_at),
    providerMetricsAvailable: snapshot.provider_metrics_captured_at !== null,
    maintenanceHealthy: snapshot.maintenance_status === null ? null : snapshot.maintenance_status === "completed",
  };
}

/**
 * Reads daily snapshots cheaply; capture performs the physical allocation scan
 * server-side and then returns the normalized stored result.
 */
export const databaseHealthRepository: DatabaseHealthRepository = {
  async readLatest() {
    return readLatest();
  },
  async capture() {
    const now = new Date();
    await sql.unsafe(MEASURE_USAGE_SQL, [now, STORAGE_BUDGET_BYTES, null, null, null] as never[]);
    return readLatest();
  },
};
