// First-run model for a monitor's early life. A monitor moves through three
// phases anchored on activatedAt, the instant of its first successful check.
//
//   setup       activatedAt is null. The monitor is verifying setup. Failures
//               are warnings, never incidents or downtime.
//   collecting  activated less than 24 hours ago. One observed-uptime figure
//               stands in for the range cards until a full day accrues.
//   active      activated at least 24 hours ago. Range cards unlock as their
//               window fills.
//
// This concept is distinct from the timeline bucket state also named
// "verifying" in timeline.ts, which marks a partial-failure bucket. The phases
// here describe the monitor as a whole, never a single bucket.

export type MonitorPhase = "setup" | "collecting" | "active";

export type AvailabilityRange = "h24" | "d7" | "d30" | "d90";

// A range unlocks once the completed data window covers its full span.
export const RANGE_UNLOCK_MS: Record<AvailabilityRange, number> = {
  h24: 86_400_000,
  d7: 7 * 86_400_000,
  d30: 30 * 86_400_000,
  d90: 90 * 86_400_000,
};

// The collecting phase spans the first day after activation.
export const COLLECTING_WINDOW_MS = 86_400_000;

export function observedMs(activatedAt: Date | null, now: Date): number {
  if (activatedAt === null) return 0;
  return Math.max(0, now.getTime() - activatedAt.getTime());
}

export function firstRunPhase(activatedAt: Date | null, now: Date): MonitorPhase {
  if (activatedAt === null) return "setup";
  return observedMs(activatedAt, now) < COLLECTING_WINDOW_MS ? "collecting" : "active";
}

// A range card reads only completed buckets, so unlock compares against the
// completed range end, not wall-clock now. The range unlocks once that end
// reaches a full window back to activation. Comparing against now would unlock
// a range while its newest bucket is still forming, showing a full-range score
// over a window short one bucket.
export function isRangeUnlocked(
  range: AvailabilityRange,
  activatedAt: Date | null,
  completedRangeEnd: Date,
): boolean {
  if (activatedAt === null) return false;
  return completedRangeEnd.getTime() - RANGE_UNLOCK_MS[range] >= activatedAt.getTime();
}

// Keeps only rollup buckets whose start is at or after activation. The bucket
// that straddles activation is excluded whole, so setup-phase failures inside
// it never reach observed uptime or coverage. An unactivated monitor has no
// observed data.
export function rollupsSinceActivation<T extends { bucketStart: Date }>(
  rows: T[],
  activatedAt: Date | null,
): T[] {
  if (activatedAt === null) return [];
  const cutoff = activatedAt.getTime();
  return rows.filter((row) => row.bucketStart.getTime() >= cutoff);
}

export type ObservedCounts = {
  expected: number;
  completed: number;
  successful: number;
  failed: number;
  uptime: number | null;
  coverage: number | null;
};

// Uptime divides successful by completed, so a stalled scheduler cannot inflate
// it. Coverage divides completed by expected, exposing that stall on its own.
export function summarizeCounts(rows: Array<{
  expectedChecks: number;
  completedChecks: number;
  successfulChecks: number;
  failedChecks: number;
}>): ObservedCounts {
  const expected = rows.reduce((sum, row) => sum + row.expectedChecks, 0);
  const completed = rows.reduce((sum, row) => sum + row.completedChecks, 0);
  const successful = rows.reduce((sum, row) => sum + row.successfulChecks, 0);
  const failed = rows.reduce((sum, row) => sum + row.failedChecks, 0);
  return {
    expected,
    completed,
    successful,
    failed,
    uptime: completed === 0 ? null : 100 * successful / completed,
    coverage: expected === 0 ? null : completed / expected,
  };
}

export type UptimeTone = "healthy" | "degraded" | "down" | "collecting" | "unknown";

// Color semantics for an uptime figure.
//   down       currently down or an ongoing incident.
//   degraded   recently resolved or any failing history in a healthy monitor.
//   collecting a range still filling, shown as a placeholder not a score.
//   unknown    no completed checks in the window.
//   healthy    currently up with a full, clean window.
export function uptimeTone(input: {
  unlocked: boolean;
  currentlyDown: boolean;
  recentlyDegraded: boolean;
  uptime: number | null;
}): UptimeTone {
  if (!input.unlocked) return "collecting";
  if (input.uptime === null) return "unknown";
  if (input.currentlyDown) return "down";
  if (input.recentlyDegraded || input.uptime < 99.9) return "degraded";
  return "healthy";
}
