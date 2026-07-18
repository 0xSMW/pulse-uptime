export const STORAGE_BUDGET_BYTES = 500_000_000;

export const governorModes = ["full", "compact_early", "shortened", "incident_only", "essential"] as const;
export type GovernorMode = typeof governorModes[number];

export type RetentionPolicy = {
  minuteHours: number;
  quarterHourDays: number;
  hourlyDays: number;
  preserveIncidentDetail: boolean;
  preserveDaily: boolean;
};

export function governorMode(projectedBytes: bigint, budgetBytes = BigInt(STORAGE_BUDGET_BYTES)): GovernorMode {
  if (projectedBytes < 0n || budgetBytes <= 0n) throw new RangeError("Storage values must be valid");
  const basisPoints = projectedBytes * 10_000n / budgetBytes;
  if (basisPoints < 6_000n) return "full";
  if (basisPoints < 7_500n) return "compact_early";
  if (basisPoints < 8_500n) return "shortened";
  if (projectedBytes * 100n <= budgetBytes * 95n) return "incident_only";
  return "essential";
}

export function retentionFor(mode: GovernorMode): RetentionPolicy {
  switch (mode) {
    case "full": return { minuteHours: 48, quarterHourDays: 7, hourlyDays: 30, preserveIncidentDetail: true, preserveDaily: true };
    case "compact_early": return { minuteHours: 36, quarterHourDays: 7, hourlyDays: 30, preserveIncidentDetail: true, preserveDaily: true };
    case "shortened": return { minuteHours: 24, quarterHourDays: 3, hourlyDays: 30, preserveIncidentDetail: true, preserveDaily: true };
    case "incident_only": return { minuteHours: 12, quarterHourDays: 1, hourlyDays: 14, preserveIncidentDetail: true, preserveDaily: true };
    case "essential": return { minuteHours: 0, quarterHourDays: 0, hourlyDays: 0, preserveIncidentDetail: false, preserveDaily: true };
  }
}
