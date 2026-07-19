export const DATABASE_STORAGE_BUDGET_BYTES = 500_000_000;
export const MONTHLY_TRANSFER_BUDGET_BYTES = 5_000_000_000;
export const DATABASE_HEALTH_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
export const DATABASE_HEALTH_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

export const DATABASE_HEALTH_CATEGORY_KEYS = [
  "recentCheckBatches",
  "rollups",
  "exceptions",
  "incidents",
  "coreData",
  "operations",
  "content",
  "indexes",
  "other",
] as const;

export type DatabaseHealthCategoryKey = (typeof DATABASE_HEALTH_CATEGORY_KEYS)[number];
export type AttributedDatabaseCategoryKey = Exclude<DatabaseHealthCategoryKey, "other">;

export type DatabaseHealthState =
  | "HEALTHY"
  | "WATCHING"
  | "OPTIMIZING"
  | "PROTECTING"
  | "CRITICAL"
  | "UNKNOWN";

export type DatabaseGovernorMode =
  | "FULL_DETAIL"
  | "EARLY_COMPACTION"
  | "SHORTENED_RETENTION"
  | "INCIDENT_HOURLY_ONLY"
  | "ESSENTIALS_ONLY"
  | "UNKNOWN";

export type DatabaseRetentionMeasurement = {
  key: string;
  label: string;
  configuredSeconds: number | null;
  oldestAt: Date | null;
};

/** Storage-owned input. Dates stay as Dates until the application boundary. */
export type DatabaseHealthMeasurement = {
  capturedAt: Date;
  storageBytes: number | null;
  otherBytes: number | null;
  projected30DayBytes: number | null;
  categoryBytes: Partial<Record<AttributedDatabaseCategoryKey, number>>;
  retention: DatabaseRetentionMeasurement[];
  governorMode: DatabaseGovernorMode;
  governorAction: string | null;
  lastCompactionAt: Date | null;
  schedulerCoverage: number | null;
  monthlyTransferBytes: number | null;
  projectedMonthlyTransferBytes: number | null;
  providerMetricsAvailable: boolean;
  providerMetricsCapturedAt: Date | null;
  maintenanceHealthy: boolean | null;
};

export interface DatabaseHealthRepository {
  readLatest(): Promise<DatabaseHealthMeasurement | null>;
  capture(): Promise<DatabaseHealthMeasurement | null>;
}

export type DatabaseHealth = {
  health: DatabaseHealthState;
  summary: string;
  budgetBytes: number;
  usedBytes: number | null;
  availableBytes: number | null;
  projected30DayBytes: number | null;
  categories: Array<{ key: DatabaseHealthCategoryKey; label: string; bytes: number }>;
  retention: Array<{ key: string; label: string; configuredSeconds: number | null; oldestAt: string | null }>;
  governor: { mode: DatabaseGovernorMode; action: string; lastCompactionAt: string | null };
  schedulerCoverage: number | null;
  transfer: { usedBytes: number | null; budgetBytes: number; projectedBytes: number | null };
  freshness: {
    capturedAt: string | null;
    ageSeconds: number | null;
    stale: boolean;
    providerMetricsAvailable: boolean;
    providerCapturedAt: string | null;
    providerAgeSeconds: number | null;
  };
  maintenanceHealthy: boolean | null;
  refresh: {
    cached: boolean;
    status: "CURRENT" | "CACHED" | "STALE_FALLBACK";
    nextEligibleAt: string | null;
  };
};
