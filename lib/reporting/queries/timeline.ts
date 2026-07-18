import type { TimelineBucket } from "@/components/monitors/timeline-bar";

export type DailyAvailability = {
  day: string;
  totalChecks: number;
  failedChecks: number;
  incidentSeconds: number;
};

export type CheckAvailability = {
  checkedAt: Date;
  successful: boolean;
};

export type RollupAvailability = {
  bucketStart: Date;
  expectedChecks: number;
  completedChecks: number;
  successfulChecks: number;
  failedChecks: number;
  unknownChecks: number;
  downtimeSeconds: number;
};

export function summarizeRollupCoverage(rows: Array<Pick<RollupAvailability,
  "expectedChecks" | "completedChecks" | "successfulChecks">>): {
  uptime: number | null;
  coverage: number | null;
} {
  const expected = rows.reduce((sum, row) => sum + row.expectedChecks, 0);
  const completed = rows.reduce((sum, row) => sum + row.completedChecks, 0);
  const successful = rows.reduce((sum, row) => sum + row.successfulChecks, 0);
  return {
    uptime: completed === 0 ? null : 100 * successful / completed,
    coverage: expected === 0 ? null : completed / expected,
  };
}

export function buildCheckTimeline(
  rows: CheckAvailability[],
  bucketCount: number,
  durationMs: number,
  now = new Date(),
): TimelineBucket[] {
  const startMs = now.getTime() - durationMs;
  const width = durationMs / bucketCount;

  return Array.from({ length: bucketCount }, (_, index) => {
    const bucketStart = startMs + index * width;
    const bucketEnd = bucketStart + width;
    const checks = rows.filter((row) => {
      const timestamp = row.checkedAt.getTime();
      return timestamp >= bucketStart && timestamp < bucketEnd;
    });
    const failures = checks.filter((row) => !row.successful).length;
    return {
      state: checks.length === 0
        ? "no-data"
        : failures === 0
          ? "up"
          : failures === checks.length
            ? "down"
            : "verifying",
      label: `${new Date(bucketStart).toISOString()}–${new Date(bucketEnd).toISOString()}`,
      checks: checks.length,
      failures,
    };
  });
}

export function buildDailyTimeline(
  rows: DailyAvailability[],
  days: number,
  now = new Date(),
): TimelineBucket[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - (days - index - 1));
    const day = date.toISOString().slice(0, 10);
    const row = byDay.get(day);
    const checks = row?.totalChecks ?? 0;
    const failures = row?.failedChecks ?? 0;
    const state: TimelineBucket["state"] = checks === 0
      ? "no-data"
      : failures === 0
        ? "up"
        : failures === checks
          ? "down"
          : "verifying";

    return {
      state,
      label: day,
      checks,
      failures,
      downtimeSeconds: row?.incidentSeconds ?? 0,
    };
  });
}

export function buildRollupTimeline(
  rows: RollupAvailability[],
  bucketCount: number,
  durationMs: number,
  now = new Date(),
): TimelineBucket[] {
  const startMs = now.getTime() - durationMs;
  const width = durationMs / bucketCount;

  return Array.from({ length: bucketCount }, (_, index) => {
    const bucketStart = startMs + index * width;
    const bucketEnd = bucketStart + width;
    const included = rows.filter((row) => {
      const timestamp = row.bucketStart.getTime();
      return timestamp >= bucketStart && timestamp < bucketEnd;
    });
    const checks = included.reduce((sum, row) => sum + row.expectedChecks, 0);
    const completed = included.reduce((sum, row) => sum + row.completedChecks, 0);
    const failures = included.reduce((sum, row) => sum + row.failedChecks, 0);
    const downtimeSeconds = included.reduce((sum, row) => sum + row.downtimeSeconds, 0);
    const state: TimelineBucket["state"] = checks === 0 || completed === 0
      ? "no-data"
      : failures === 0 && completed === checks
        ? "up"
        : failures === completed && completed === checks
          ? "down"
          : "verifying";

    return {
      state,
      label: `${new Date(bucketStart).toISOString()}–${new Date(bucketEnd).toISOString()}`,
      checks,
      failures,
      downtimeSeconds,
    };
  });
}

export function statusGroupSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "other";
}
