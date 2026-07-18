import "server-only";

import { databaseHealthRepository } from "./repository";
import {
  DATABASE_HEALTH_CATEGORY_KEYS,
  DATABASE_HEALTH_REFRESH_INTERVAL_MS,
  DATABASE_HEALTH_STALE_AFTER_MS,
  DATABASE_STORAGE_BUDGET_BYTES,
  MONTHLY_TRANSFER_BUDGET_BYTES,
  type AttributedDatabaseCategoryKey,
  type DatabaseGovernorMode,
  type DatabaseHealth,
  type DatabaseHealthCategoryKey,
  type DatabaseHealthMeasurement,
  type DatabaseHealthRepository,
  type DatabaseHealthState,
} from "./types";

const CATEGORY_LABELS: Record<DatabaseHealthCategoryKey, string> = {
  recentCheckBatches: "Recent check batches",
  rollups: "Rollups",
  exceptions: "Exceptions",
  incidents: "Incidents",
  coreData: "Core data",
  operations: "Operations",
  content: "Images & reports",
  indexes: "Indexes",
  other: "Other",
};

const DEFAULT_ACTIONS: Record<DatabaseGovernorMode, string> = {
  FULL_DETAIL: "Keeping full configured detail",
  EARLY_COMPACTION: "Compacting completed buckets early",
  SHORTENED_RETENTION: "Shortening minute and 15-minute retention",
  INCIDENT_HOURLY_ONLY: "Keeping hourly detail around incidents",
  ESSENTIALS_ONLY: "Preserving current state, incidents, and daily rollups",
  UNKNOWN: "Waiting for current retention metrics",
};

type CacheEntry = { measurement: DatabaseHealthMeasurement; eligibleAt: number };
const cache = new WeakMap<DatabaseHealthRepository, CacheEntry>();
const refreshes = new WeakMap<DatabaseHealthRepository, Promise<DatabaseHealthMeasurement | null>>();

export class DatabaseHealthUnavailableError extends Error {
  constructor() {
    super("Database health measurements are unavailable");
    this.name = "DatabaseHealthUnavailableError";
  }
}

function finiteBytes(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

export function deriveDatabaseHealthState(
  measurement: DatabaseHealthMeasurement,
  now = new Date(),
): DatabaseHealthState {
  const age = now.valueOf() - measurement.capturedAt.valueOf();
  const providerAge = measurement.providerMetricsCapturedAt === null
    ? Number.POSITIVE_INFINITY
    : now.valueOf() - measurement.providerMetricsCapturedAt.valueOf();
  if (measurement.maintenanceHealthy === false) return "CRITICAL";
  if (
    !measurement.providerMetricsAvailable
    || measurement.maintenanceHealthy === null
    || !Number.isFinite(age)
    || age > DATABASE_HEALTH_STALE_AFTER_MS
    || !Number.isFinite(providerAge)
    || providerAge > DATABASE_HEALTH_STALE_AFTER_MS
  ) return "UNKNOWN";
  const projected = finiteBytes(measurement.projected30DayBytes);
  if (projected === null) return "UNKNOWN";
  const utilization = projected / DATABASE_STORAGE_BUDGET_BYTES;
  if (utilization > 0.95 || measurement.governorMode === "ESSENTIALS_ONLY") return "CRITICAL";
  if (utilization >= 0.85 || measurement.governorMode === "INCIDENT_HOURLY_ONLY") return "PROTECTING";
  if (utilization >= 0.75 || ["EARLY_COMPACTION", "SHORTENED_RETENTION"].includes(measurement.governorMode)) return "OPTIMIZING";
  if (utilization >= 0.6) return "WATCHING";
  return "HEALTHY";
}

function summaryFor(state: DatabaseHealthState): string {
  switch (state) {
    case "HEALTHY": return "Storage remains within its configured budget";
    case "WATCHING": return "Projected usage is approaching the budget";
    case "OPTIMIZING": return "Automatic compaction is reducing growth";
    case "PROTECTING": return "Fine-grained retention is being reduced";
    case "CRITICAL": return "Storage or maintenance needs attention";
    case "UNKNOWN": return "Current database metrics are unavailable";
  }
}

export function presentDatabaseHealth(
  measurement: DatabaseHealthMeasurement,
  options: { now?: Date; refreshStatus?: DatabaseHealth["refresh"]["status"] } = {},
): DatabaseHealth {
  const now = options.now ?? new Date();
  const usedBytes = finiteBytes(measurement.storageBytes);
  const projected30DayBytes = finiteBytes(measurement.projected30DayBytes);
  const ageMs = Math.max(0, now.valueOf() - measurement.capturedAt.valueOf());
  const providerAgeMs = measurement.providerMetricsCapturedAt === null
    ? null
    : Math.max(0, now.valueOf() - measurement.providerMetricsCapturedAt.valueOf());
  const stale = !Number.isFinite(ageMs)
    || ageMs > DATABASE_HEALTH_STALE_AFTER_MS
    || providerAgeMs === null
    || !Number.isFinite(providerAgeMs)
    || providerAgeMs > DATABASE_HEALTH_STALE_AFTER_MS;
  const attributed = DATABASE_HEALTH_CATEGORY_KEYS.filter((key): key is AttributedDatabaseCategoryKey => key !== "other")
    .map((key) => ({ key, label: CATEGORY_LABELS[key], bytes: finiteBytes(measurement.categoryBytes[key]) ?? 0 }));
  const attributedBytes = attributed.reduce((total, category) => total + category.bytes, 0);
  const categories = [...attributed, {
    key: "other" as const,
    label: CATEGORY_LABELS.other,
    bytes: finiteBytes(measurement.otherBytes) ?? Math.max(0, (usedBytes ?? attributedBytes) - attributedBytes),
  }];
  const health = deriveDatabaseHealthState(measurement, now);
  const eligibleAt = measurement.capturedAt.valueOf() + DATABASE_HEALTH_REFRESH_INTERVAL_MS;

  return {
    health,
    summary: summaryFor(health),
    budgetBytes: DATABASE_STORAGE_BUDGET_BYTES,
    usedBytes,
    availableBytes: usedBytes === null ? null : Math.max(0, DATABASE_STORAGE_BUDGET_BYTES - usedBytes),
    projected30DayBytes,
    categories,
    retention: measurement.retention.map((item) => ({
      ...item,
      configuredSeconds: item.configuredSeconds === null ? null : Math.max(0, Math.round(item.configuredSeconds)),
      oldestAt: item.oldestAt?.toISOString() ?? null,
    })),
    governor: {
      mode: measurement.governorMode,
      action: measurement.governorAction?.trim() || DEFAULT_ACTIONS[measurement.governorMode],
      lastCompactionAt: measurement.lastCompactionAt?.toISOString() ?? null,
    },
    schedulerCoverage: measurement.schedulerCoverage === null ? null : Math.min(1, Math.max(0, measurement.schedulerCoverage)),
    transfer: {
      usedBytes: finiteBytes(measurement.monthlyTransferBytes),
      budgetBytes: MONTHLY_TRANSFER_BUDGET_BYTES,
      projectedBytes: finiteBytes(measurement.projectedMonthlyTransferBytes),
    },
    freshness: {
      capturedAt: measurement.capturedAt.toISOString(),
      ageSeconds: Math.round(ageMs / 1000),
      stale,
      providerMetricsAvailable: measurement.providerMetricsAvailable,
      providerCapturedAt: measurement.providerMetricsCapturedAt?.toISOString() ?? null,
      providerAgeSeconds: providerAgeMs === null ? null : Math.round(providerAgeMs / 1000),
    },
    maintenanceHealthy: measurement.maintenanceHealthy,
    refresh: {
      cached: options.refreshStatus === "CACHED",
      status: options.refreshStatus ?? "CURRENT",
      nextEligibleAt: new Date(eligibleAt).toISOString(),
    },
  };
}

export async function getDatabaseHealth(
  repository: DatabaseHealthRepository = databaseHealthRepository,
  now = new Date(),
): Promise<DatabaseHealth | null> {
  const cached = cache.get(repository);
  if (cached && cached.eligibleAt > now.valueOf()) return presentDatabaseHealth(cached.measurement, { now, refreshStatus: "CACHED" });
  let measurement: DatabaseHealthMeasurement | null;
  try {
    measurement = await repository.readLatest();
  } catch {
    throw new DatabaseHealthUnavailableError();
  }
  if (!measurement) return null;
  cache.set(repository, { measurement, eligibleAt: measurement.capturedAt.valueOf() + DATABASE_HEALTH_REFRESH_INTERVAL_MS });
  return presentDatabaseHealth(measurement, { now });
}

export async function refreshDatabaseHealth(
  repository: DatabaseHealthRepository = databaseHealthRepository,
  now = new Date(),
): Promise<DatabaseHealth> {
  let current = cache.get(repository)?.measurement ?? null;
  if (!current) {
    try {
      current = await repository.readLatest();
    } catch {
      // A capture may recover a failed read; otherwise the API returns a safe unavailable error.
    }
  }
  if (current && current.capturedAt.valueOf() + DATABASE_HEALTH_REFRESH_INTERVAL_MS > now.valueOf()) {
    cache.set(repository, { measurement: current, eligibleAt: current.capturedAt.valueOf() + DATABASE_HEALTH_REFRESH_INTERVAL_MS });
    return presentDatabaseHealth(current, { now, refreshStatus: "CACHED" });
  }
  let pending = refreshes.get(repository);
  if (!pending) {
    pending = repository.capture();
    refreshes.set(repository, pending);
  }
  let measurement: DatabaseHealthMeasurement | null;
  try {
    measurement = await pending;
  } catch {
    if (current) return presentDatabaseHealth(current, { now, refreshStatus: "STALE_FALLBACK" });
    throw new DatabaseHealthUnavailableError();
  } finally {
    if (refreshes.get(repository) === pending) refreshes.delete(repository);
  }
  if (!measurement) {
    if (current) return presentDatabaseHealth(current, { now, refreshStatus: "STALE_FALLBACK" });
    throw new DatabaseHealthUnavailableError();
  }
  cache.set(repository, { measurement, eligibleAt: measurement.capturedAt.valueOf() + DATABASE_HEALTH_REFRESH_INTERVAL_MS });
  return presentDatabaseHealth(measurement, { now });
}

export function clearDatabaseHealthCache(repository: DatabaseHealthRepository): void {
  cache.delete(repository);
}
