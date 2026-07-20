// Pure detection of a broken scheduler loop from recent cron_runs. Kept free
// of any database or notification dependency so it is trivially testable and
// can be reused by both the dashboard health banner and the sweep cross-check.

export type CronRunStatus = "running" | "completed" | "failed";

// Default number of consecutive terminal failures that flags a route as
// failing. Three keeps a single transient error from raising the alarm while
// still catching a genuinely stuck loop within a few minutes.
export const CONSECUTIVE_FAILURE_THRESHOLD = 3;

// A monitor-check run is expected every minute. The dashboard warns at three
// minutes. The email alert waits five so a couple of missed invocations do not
// page an operator, while a true silent stop is still caught quickly.
export const MONITORING_ALERT_STALE_MS = 5 * 60_000;

/**
 * Counts leading `failed` runs in a list ordered most-recent first. A
 * `completed` run (or any non-failed terminal status) resets the streak, so a
 * loop that has recovered reads as zero even if older failures remain.
 */
export function countLeadingFailures(statuses: readonly CronRunStatus[]): number {
  let count = 0;
  for (const status of statuses) {
    if (status === "failed") count += 1;
    else break;
  }
  return count;
}

/**
 * True when the most recent successful completion is older than `staleMs`, or
 * when there has never been one. A never-completed loop is stale by definition.
 */
export function isLoopStale(lastCompletedAt: Date | null, now: Date, staleMs: number): boolean {
  if (!lastCompletedAt) return true;
  return now.getTime() - lastCompletedAt.getTime() > staleMs;
}

export type LoopHealthReason = "stale" | "consecutive-failures";

export type LoopHealthInput = {
  lastCompletedAt: Date | null;
  recentStatuses: readonly CronRunStatus[];
  now: Date;
  staleMs?: number;
  threshold?: number;
};

/**
 * Evaluates whether the monitoring loop is unhealthy. Staleness (no fresh
 * completion) is reported first because a silent stop leaves no failed rows at
 * all, then a run of consecutive terminal failures. A healthy loop returns
 * `{ unhealthy: false, reason: null }`.
 */
export function evaluateLoopHealth(
  input: LoopHealthInput,
): { unhealthy: boolean; reason: LoopHealthReason | null; failures: number } {
  const staleMs = input.staleMs ?? MONITORING_ALERT_STALE_MS;
  const threshold = input.threshold ?? CONSECUTIVE_FAILURE_THRESHOLD;
  const failures = countLeadingFailures(input.recentStatuses);
  if (isLoopStale(input.lastCompletedAt, input.now, staleMs)) {
    return { unhealthy: true, reason: "stale", failures };
  }
  if (failures >= threshold) {
    return { unhealthy: true, reason: "consecutive-failures", failures };
  }
  return { unhealthy: false, reason: null, failures };
}
