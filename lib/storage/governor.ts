import type { DatabaseGovernorMode } from "@/lib/database-health/types"

export const STORAGE_BUDGET_BYTES = 500_000_000

const governorModes = [
  "full",
  "compact_early",
  "shortened",
  "incident_only",
  "essential",
] as const
export type GovernorMode = (typeof governorModes)[number]

// Projected usage as a percent of budget at or above which each stricter mode
// begins. full below compactEarly, compact_early up to shortened, shortened up
// to incidentOnly, incident_only up to and including essential, essential above.
// MEASURE_USAGE_SQL interpolates these so the SQL CASE and governorMode() share
// one source.
export const GOVERNOR_THRESHOLD_PERCENTS = {
  compactEarly: 60,
  shortened: 75,
  incidentOnly: 85,
  essential: 95,
} as const

// Per-mode retention action copy, declarative present tense, shared by the
// repository measurement and the presentation fallback so both read the same.
export const GOVERNOR_ACTIONS: Record<DatabaseGovernorMode, string> = {
  FULL_DETAIL: "Full configured detail is retained",
  EARLY_COMPACTION: "Completed buckets are compacted early",
  SHORTENED_RETENTION: "Minute and 15-minute retention is shorter",
  INCIDENT_HOURLY_ONLY: "Hourly detail is retained around incidents",
  ESSENTIALS_ONLY: "Current state, incidents, and daily uptime are preserved",
  UNKNOWN: "Waiting for current retention metrics",
}

export interface RetentionPolicy {
  minuteHours: number
  quarterHourDays: number
  hourlyDays: number
  preserveIncidentDetail: boolean
  preserveDaily: boolean
}

export function governorMode(
  projectedBytes: bigint,
  budgetBytes = BigInt(STORAGE_BUDGET_BYTES)
): GovernorMode {
  if (projectedBytes < 0n || budgetBytes <= 0n) {
    throw new RangeError("Storage values must be valid")
  }
  const basisPoints = (projectedBytes * 10_000n) / budgetBytes
  if (basisPoints < BigInt(GOVERNOR_THRESHOLD_PERCENTS.compactEarly) * 100n) {
    return "full"
  }
  if (basisPoints < BigInt(GOVERNOR_THRESHOLD_PERCENTS.shortened) * 100n) {
    return "compact_early"
  }
  if (basisPoints < BigInt(GOVERNOR_THRESHOLD_PERCENTS.incidentOnly) * 100n) {
    return "shortened"
  }
  if (
    projectedBytes * 100n <=
    budgetBytes * BigInt(GOVERNOR_THRESHOLD_PERCENTS.essential)
  ) {
    return "incident_only"
  }
  return "essential"
}

export function retentionFor(mode: GovernorMode): RetentionPolicy {
  switch (mode) {
    case "full":
      return {
        minuteHours: 48,
        quarterHourDays: 7,
        hourlyDays: 30,
        preserveIncidentDetail: true,
        preserveDaily: true,
      }
    case "compact_early":
      return {
        minuteHours: 36,
        quarterHourDays: 7,
        hourlyDays: 30,
        preserveIncidentDetail: true,
        preserveDaily: true,
      }
    case "shortened":
      return {
        minuteHours: 24,
        quarterHourDays: 3,
        hourlyDays: 30,
        preserveIncidentDetail: true,
        preserveDaily: true,
      }
    case "incident_only":
      return {
        minuteHours: 12,
        quarterHourDays: 1,
        hourlyDays: 14,
        preserveIncidentDetail: true,
        preserveDaily: true,
      }
    case "essential":
      return {
        minuteHours: 0,
        quarterHourDays: 0,
        hourlyDays: 0,
        preserveIncidentDetail: false,
        preserveDaily: true,
      }
  }
}
