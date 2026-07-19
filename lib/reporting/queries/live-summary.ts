// Shaping for the changing sections of a monitor page. These build their output
// from already-fetched rows, so the same shapes feed both the server snapshot
// and the polled live payload. No database access lives here, which keeps the
// payload logic pure and testable.

import type { MonitorState } from "@/components/monitors/status-dot";

import {
  firstRunPhase,
  observedMs,
  type AvailabilityRange,
  type MonitorPhase,
  type ObservedCounts,
} from "./first-run";

const DAY_MS = 86_400_000;

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
