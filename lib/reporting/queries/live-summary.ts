// Shaping for the changing sections of a monitor page. These build their output
// from already-fetched rows, so the same shapes feed both the server snapshot
// and the polled live payload. No database access lives here, which keeps the
// payload logic pure and testable.

import type { MonitorState } from "@/components/monitors/status-dot";

import {
  firstRunPhase,
  observedMs,
  summarizeCounts,
  type AvailabilityRange,
  type MonitorPhase,
  type ObservedCounts,
} from "./first-run";

const DAY_MS = 86_400_000;
const FIFTEEN_MINUTE_MS = 900_000;

export function secondsBetween(start: Date, end: Date): number {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1_000));
}

export function openingFailure(errorCode: string | null, statusCode: number | null): string {
  if (statusCode !== null) return `HTTP ${statusCode}`;
  return errorCode ?? "Unknown failure";
}

export type LiveIncidentRow = {
  id: string;
  openedAt: Date;
  resolvedAt: Date | null;
  openingErrorCode: string | null;
  openingStatusCode: number | null;
};

export type LiveRollupRow = {
  bucketStart: Date;
  expectedChecks: number;
  completedChecks: number;
  failedChecks: number;
  unknownChecks: number;
  latencyCount: number;
  latencySumMs: bigint;
};

export type LiveLatestIncident = {
  id: string;
  state: "ONGOING" | "RESOLVED";
  openedAt: string;
  resolvedAt: string | null;
  durationSeconds: number;
  openingFailure: string;
};

export type LiveRecentIncident = {
  id: string;
  openedAt: string;
  durationSeconds: number;
  openingFailure: string;
};

export type LiveRecentCheck = {
  id: string;
  checkedAt: string;
  successful: boolean;
  statusCode: number | null;
  resultLabel: string;
  latencyMs: number | null;
};

export type MonitorFirstRun = {
  phase: MonitorPhase;
  activatedAt: string | null;
  observedSeconds: number;
  observed: { uptime: number | null; completed: number; expected: number };
  setupError: string | null;
  lastCheckedAt: string | null;
};

// Ranges the live poll recomputes. The d30 and d90 figures are absent from the
// payload, so the client keeps the snapshot values that a rollup refresh
// advances rather than overwriting them with nulls each poll.
export type LiveRange = "h24" | "d7";

// The changing subset of a monitor page. The live poll returns exactly these
// fields so the client can merge them over the server snapshot in place.
export type MonitorLiveData = {
  state: MonitorState;
  enabled: boolean;
  latestLatencyMs: number | null;
  p95LatencyMs: number | null;
  lastCheckedAt: string | null;
  uptime: Record<LiveRange, number | null>;
  coverage: Record<LiveRange, number | null>;
  rangeUnlocked: Record<AvailabilityRange, boolean>;
  firstRun: MonitorFirstRun;
  latestIncident: LiveLatestIncident | null;
  recentIncidents: LiveRecentIncident[];
  recentChecks: LiveRecentCheck[];
  rollupVersion: string | null;
  // Accepted-snapshot acceptedAt, the config version governing this monitor. It
  // advances whenever an edit from any session accepts a new snapshot, the only
  // freshness signal for a paused monitor whose rollup version never moves, so a
  // name, url, threshold, or recipient change lands on the open page.
  configVersion: string | null;
};

// Identifies the last completed rollup bucket. It advances only when a new
// bucket finalizes, so a client gates chart and timeline redraws on it.
export function rollupVersionOf(rollups15m: Array<{ bucketStart: Date }>): string | null {
  const last = rollups15m.at(-1);
  return last ? last.bucketStart.toISOString() : null;
}

// The latest incident is surfaced only while ongoing or resolved within a day,
// so a stale resolution never lingers on the page.
export function buildLatestIncident(rows: LiveIncidentRow[], now: Date): LiveLatestIncident | null {
  const latest = rows[0];
  if (!latest) return null;
  const withinDay = latest.resolvedAt === null || latest.resolvedAt.getTime() >= now.getTime() - DAY_MS;
  if (!withinDay) return null;
  return {
    id: latest.id,
    state: latest.resolvedAt ? "RESOLVED" : "ONGOING",
    openedAt: latest.openedAt.toISOString(),
    resolvedAt: latest.resolvedAt?.toISOString() ?? null,
    durationSeconds: secondsBetween(latest.openedAt, latest.resolvedAt ?? now),
    openingFailure: openingFailure(latest.openingErrorCode, latest.openingStatusCode),
  };
}

export function buildRecentIncidents(rows: LiveIncidentRow[], now: Date): LiveRecentIncident[] {
  return rows.map((incident) => ({
    id: incident.id,
    openedAt: incident.openedAt.toISOString(),
    durationSeconds: secondsBetween(incident.openedAt, incident.resolvedAt ?? now),
    openingFailure: openingFailure(incident.openingErrorCode, incident.openingStatusCode),
  }));
}

export type RawMinuteCheck = {
  checked_at: Date;
  completed: boolean;
  failed: boolean;
  latency_ms: number | null;
};

// Keeps only raw minute checks recorded at or after activation, the same cutoff
// rollupsSinceActivation applies to buckets. An unactivated monitor has no
// post-activation checks, so its recent-checks list is empty, matching how
// incidents and uptime exclude setup-phase data.
export function rawChecksSinceActivation(
  checks: RawMinuteCheck[],
  activatedAt: Date | null,
): RawMinuteCheck[] {
  if (activatedAt === null) return [];
  const cutoff = activatedAt.getTime();
  return checks.filter((check) => check.checked_at.getTime() >= cutoff);
}

// Raw minute rows carry real per-check results, so they take precedence over
// the rollup-derived rows below whenever the retention window still has them.
export function buildRecentChecksFromRaw(checks: RawMinuteCheck[]): LiveRecentCheck[] {
  return checks.map((check) => ({
    id: `minute:${check.checked_at.toISOString()}`,
    checkedAt: check.checked_at.toISOString(),
    successful: check.completed && !check.failed,
    statusCode: null,
    resultLabel: check.completed ? (check.failed ? "Failed" : "Passed") : "No response recorded",
    latencyMs: check.latency_ms,
  }));
}

export function buildRecentChecks(rollups24h: LiveRollupRow[]): LiveRecentCheck[] {
  return rollups24h.slice(-20).toReversed().map((rollup) => ({
    id: `15m:${rollup.bucketStart.toISOString()}`,
    checkedAt: rollup.bucketStart.toISOString(),
    successful: rollup.failedChecks === 0 && rollup.completedChecks === rollup.expectedChecks,
    statusCode: null,
    resultLabel: rollup.unknownChecks > 0 ? "Unknown coverage" : rollup.failedChecks > 0 ? "Failed checks" : "Healthy rollup",
    latencyMs: rollup.latencyCount === 0 ? null : Math.round(Number(rollup.latencySumMs) / rollup.latencyCount),
  }));
}

// Folds the uncompacted post-activation raw minutes into the collecting-card
// observed counts. The base counts come from completed rollup buckets since
// activation, ordered oldest first. Only raw checks at or after the newest
// completed bucket end join in, the minutes no rollup covers yet, so no minute
// is counted twice. Each raw row is one expected check, so expected counts
// every tail row while completed, successful, and failed read its flags. An
// unknown tail minute lowers coverage without touching uptime, and completed
// never exceeds expected nor successful completed, so uptime stays at or below
// 100. With no completed buckets yet the whole tail counts, so the first
// successes show the moment they land instead of waiting for the first bucket.
export function observedWithRawTail(
  completedRollups: Array<{
    bucketStart: Date;
    expectedChecks: number;
    completedChecks: number;
    successfulChecks: number;
    failedChecks: number;
  }>,
  rawTail: RawMinuteCheck[],
): ObservedCounts {
  const base = summarizeCounts(completedRollups);
  const lastBucketEnd = completedRollups.length === 0
    ? null
    : completedRollups[completedRollups.length - 1]!.bucketStart.getTime() + FIFTEEN_MINUTE_MS;
  let expected = base.expected;
  let completed = base.completed;
  let successful = base.successful;
  let failed = base.failed;
  for (const check of rawTail) {
    if (lastBucketEnd !== null && check.checked_at.getTime() < lastBucketEnd) continue;
    expected += 1;
    if (!check.completed) continue;
    completed += 1;
    if (check.failed) failed += 1;
    else successful += 1;
  }
  return {
    expected,
    completed,
    successful,
    failed,
    uptime: completed === 0 ? null : 100 * successful / completed,
    coverage: expected === 0 ? null : completed / expected,
  };
}

export type LiveMonitorIdentity = {
  activatedAt: Date | null;
  consecutiveFailures: number | null;
  lastErrorCode: string | null;
  lastStatusCode: number | null;
  lastCheckedAt: Date | null;
};

// The collecting card counts every check since monitoring began, up to the
// first full day. The setup card surfaces the last failure until activation.
export function buildFirstRun(
  monitor: LiveMonitorIdentity,
  observed24h: ObservedCounts,
  now: Date,
): MonitorFirstRun {
  const activatedAt = monitor.activatedAt;
  const phase = firstRunPhase(activatedAt, now);
  return {
    phase,
    activatedAt: activatedAt?.toISOString() ?? null,
    observedSeconds: Math.floor(observedMs(activatedAt, now) / 1_000),
    observed: {
      uptime: observed24h.uptime,
      completed: observed24h.completed,
      expected: observed24h.expected,
    },
    setupError: phase === "setup" && (monitor.consecutiveFailures ?? 0) > 0
      ? openingFailure(monitor.lastErrorCode, monitor.lastStatusCode)
      : null,
    lastCheckedAt: monitor.lastCheckedAt?.toISOString() ?? null,
  };
}
