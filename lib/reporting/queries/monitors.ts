import { and, desc, eq, gte, isNull, lt } from "drizzle-orm";
import { cache } from "react";

import { db, sql } from "@/lib/db/client";
import {
  incidents,
  metricRollups,
  monitorRegistry,
  monitoringConfigSnapshots,
  monitorState,
} from "@/lib/db/schema";
import { DEFAULT_MONITOR_VALUES } from "@/lib/config/defaults";
import { validateMonitoringConfig, type MonitorConfig } from "@/lib/config";
import { listOverlappingDependencyIncidents } from "@/lib/dependencies/overlap";
import { portableQueryValues } from "@/lib/db/query-values";
import { RECENT_MINUTE_CHECKS_SQL, RECENT_MINUTE_CHECK_TAIL_COUNTS_SQL } from "@/lib/storage/sql";

import {
  firstRunPhase,
  isRangeUnlocked,
  rollupsSinceActivation,
  summarizeCounts,
  type AvailabilityRange,
} from "./first-run";
import {
  buildFirstRun,
  buildLatestIncident,
  buildRecentChecks,
  buildRecentChecksFromRaw,
  buildRecentIncidents,
  observedWithRawTail,
  rawChecksSinceActivation,
  rawTailBounds,
  rollupVersionOf,
  type MonitorLiveData,
  type RawTailBounds,
  type RawTailCounts,
} from "./live-summary";
import { buildRollupTimeline } from "./timeline";

const LATENCY_BUCKET_MAX_MS = [100, 250, 500, 1_000, 2_500, 5_000, 10_000] as const;

function completedRangeEnd(now: Date, resolution: "15m" | "hour" | "day"): Date {
  const end = new Date(now);
  if (resolution === "day") {
    end.setUTCHours(0, 0, 0, 0);
  } else if (resolution === "hour") {
    end.setUTCMinutes(0, 0, 0);
  } else {
    end.setUTCMinutes(Math.floor(end.getUTCMinutes() / 15) * 15, 0, 0);
  }
  return end;
}

// Selects rows in [cutoffMs, endMs) from a wider window.
export function selectRecentRollupWindow<T extends { bucketStart: Date }>(
  supersetRows: T[],
  cutoffMs: number,
  endMs: number,
): T[] {
  return supersetRows.filter((row) => {
    const bucketMs = row.bucketStart.getTime();
    return bucketMs >= cutoffMs && bucketMs < endMs;
  });
}

function p95Latency(rows: Array<{
  latencyCount: number;
  latencyHistogram: number[];
  latencyMaxMs: number | null;
}>): number | null {
  const count = rows.reduce((sum, row) => sum + row.latencyCount, 0);
  if (count === 0) return null;

  const rank = Math.ceil(count * 0.95);
  let cumulative = 0;
  for (let index = 0; index < 8; index += 1) {
    cumulative += rows.reduce((sum, row) => sum + (row.latencyHistogram[index] ?? 0), 0);
    if (cumulative >= rank) {
      return index < LATENCY_BUCKET_MAX_MS.length
        ? LATENCY_BUCKET_MAX_MS[index]!
        : Math.max(...rows.map((row) => row.latencyMaxMs ?? 0));
    }
  }
  return null;
}

const ROLLUP_COLUMNS = {
  bucketStart: metricRollups.bucketStart,
  expectedChecks: metricRollups.expectedChecks,
  completedChecks: metricRollups.completedChecks,
  successfulChecks: metricRollups.successfulChecks,
  failedChecks: metricRollups.failedChecks,
  unknownChecks: metricRollups.unknownChecks,
  downtimeSeconds: metricRollups.downtimeSeconds,
  latencyCount: metricRollups.latencyCount,
  latencySumMs: metricRollups.latencySumMs,
  latencyMaxMs: metricRollups.latencyMaxMs,
  latencyHistogram: metricRollups.latencyHistogram,
};

// Fetches one resolution's buckets in [end - durationMs, end), ordered oldest
// first so the last row is the most recent completed bucket.
function fetchRollups(
  id: string,
  resolution: "15m" | "hour" | "day",
  end: Date,
  durationMs: number,
) {
  return db
    .select(ROLLUP_COLUMNS)
    .from(metricRollups)
    .where(and(
      eq(metricRollups.monitorId, id),
      eq(metricRollups.resolution, resolution),
      gte(metricRollups.bucketStart, new Date(end.getTime() - durationMs)),
      lt(metricRollups.bucketStart, end),
    ))
    .orderBy(metricRollups.bucketStart);
}

// Load identity without rollups. React cache shares the indexed lookup between
// the page shell and detail island for each request.
export const getMonitorIdentity = cache(async (id: string) => {
  const [monitor] = await db
    .select({
      id: monitorRegistry.id,
      name: monitorRegistry.name,
      url: monitorRegistry.url,
      group: monitorRegistry.groupName,
      enabled: monitorRegistry.enabled,
      state: monitorState.state,
      latestLatencyMs: monitorState.lastLatencyMs,
      activatedAt: monitorState.activatedAt,
      lastCheckedAt: monitorState.lastCheckedAt,
      lastErrorCode: monitorState.lastErrorCode,
      lastStatusCode: monitorState.lastStatusCode,
      consecutiveFailures: monitorState.consecutiveFailures,
    })
    .from(monitorRegistry)
    .leftJoin(monitorState, eq(monitorState.monitorId, monitorRegistry.id))
    .where(and(eq(monitorRegistry.id, id), isNull(monitorRegistry.archivedAt)))
    .limit(1);
  if (!monitor || monitor.state === "ARCHIVED") return null;
  return { ...monitor, state: monitor.state ?? ("PENDING" as const) };
});

export type MonitorIdentity = NonNullable<Awaited<ReturnType<typeof getMonitorIdentity>>>;

type RecentMinuteCheckRow = {
  checked_at: Date;
  completed: boolean;
  failed: boolean;
  latency_ms: number | null;
};

type RecentMinuteCheckDbRow = Omit<RecentMinuteCheckRow, "checked_at"> & { checked_at: Date | string };

const RECENT_MINUTE_CHECK_LOOKBACK_MS = 48 * 3_600_000;
const RECENT_MINUTE_CHECK_LIMIT = 20;

// db wraps this module's sql client in drizzle(), which reconfigures the
// client's own type parsers, so raw sql.unsafe queries on that same client
// return timestamptz columns as strings rather than Date instances.
function toDate(value: Date | string): Date {
  return Object.prototype.toString.call(value) === "[object Date]" ? value as Date : new Date(value);
}

// Reads raw per-check results straight from check_batches, on the monitor's
// own cadence. Raw minutes retain 12-48h depending on governor mode, 0 in
// essential mode, so callers fall back to rollup-derived rows on an empty
// result. A query or decode failure degrades the same way, an empty array,
// instead of failing a page that never used to touch check_batches.
export async function getRecentRawChecks(monitorId: string, end: Date): Promise<RecentMinuteCheckRow[]> {
  const start = new Date(end.getTime() - RECENT_MINUTE_CHECK_LOOKBACK_MS);
  try {
    const rows = await sql.unsafe(
      RECENT_MINUTE_CHECKS_SQL,
      portableQueryValues([monitorId, start, end, RECENT_MINUTE_CHECK_LIMIT]) as never[],
    ) as unknown as RecentMinuteCheckDbRow[];
    return rows.map((row) => ({ ...row, checked_at: toDate(row.checked_at) }));
  } catch {
    return [];
  }
}

const EMPTY_TAIL_COUNTS: RawTailCounts = { expected: 0, completed: 0, successful: 0, failed: 0 };

type RawTailCountsDbRow = {
  expected: number | string;
  completed: number | string;
  successful: number | string;
  failed: number | string;
};

// Aggregates the raw post-activation minutes no rollup counts into observed
// counts. It scans [activationFloor, end) minus the counted rollup middle
// [firstCountedBucketStart, lastCompletedBucketEnd), so the collecting card folds
// the activation-bucket segment and the uncompacted tail without double counting
// the compacted middle, reading the full contribution rather than the newest rows
// the display query caps at. An empty window or a decode failure degrades to zero
// counts, so the card falls back to the completed rollups alone.
export async function getRawTailCounts(monitorId: string, bounds: RawTailBounds, end: Date): Promise<RawTailCounts> {
  if (bounds.activationFloor.getTime() >= end.getTime()) return EMPTY_TAIL_COUNTS;
  try {
    const rows = await sql.unsafe(
      RECENT_MINUTE_CHECK_TAIL_COUNTS_SQL,
      portableQueryValues([
        monitorId,
        bounds.activationFloor,
        end,
        bounds.firstCountedBucketStart,
        bounds.lastCompletedBucketEnd,
      ]) as never[],
    ) as unknown as RawTailCountsDbRow[];
    const row = rows[0];
    if (!row) return EMPTY_TAIL_COUNTS;
    return {
      expected: Number(row.expected) || 0,
      completed: Number(row.completed) || 0,
      successful: Number(row.successful) || 0,
      failed: Number(row.failed) || 0,
    };
  } catch {
    return EMPTY_TAIL_COUNTS;
  }
}

export async function getMonitorDetail(id: string) {
  const monitor = await getMonitorIdentity(id);
  if (!monitor) return null;

  // First-run model. activatedAt anchors phase, observed duration, and the
  // range unlocks. Uptime, coverage, latency, and incidents count only data at
  // or after activation, so setup-phase failures never define the monitor. A
  // monitor with no activation surfaces no incidents at all.
  const activatedAt = monitor.activatedAt;
  const now = new Date();
  const end15m = completedRangeEnd(now, "15m");
  const endHour = completedRangeEnd(now, "hour");
  const endDay = completedRangeEnd(now, "day");
  const [rollups7d, rollups30d, rollups90d, recentIncidents, accepted, recentRawChecks] = await Promise.all([
    fetchRollups(id, "15m", end15m, 7 * 86_400_000),
    fetchRollups(id, "hour", endHour, 30 * 86_400_000),
    fetchRollups(id, "day", endDay, 90 * 86_400_000),
    activatedAt === null
      ? Promise.resolve([])
      : db.select().from(incidents)
          .where(and(eq(incidents.monitorId, id), gte(incidents.openedAt, activatedAt)))
          .orderBy(desc(incidents.openedAt))
          .limit(5),
    db.select({
      configJson: monitoringConfigSnapshots.configJson,
      acceptedAt: monitoringConfigSnapshots.acceptedAt,
    })
      .from(monitoringConfigSnapshots)
      .where(eq(monitoringConfigSnapshots.status, "accepted"))
      .orderBy(desc(monitoringConfigSnapshots.acceptedAt))
      .limit(1),
    getRecentRawChecks(id, now),
  ]);

  // Derive the last 24 hours from the fetched seven days of rollups.
  const rollups24h = selectRecentRollupWindow(rollups7d, end15m.getTime() - 86_400_000, end15m.getTime());
  const activeRawChecks = rawChecksSinceActivation(recentRawChecks, activatedAt);

  const activeRollups24h = rollupsSinceActivation(rollups24h, activatedAt);
  const observed24h = summarizeCounts(activeRollups24h);
  // The collecting card counts every post-activation minute, so it folds the raw
  // minutes no rollup counts onto the completed rollups. Only the collecting phase
  // renders that card, so the raw aggregate runs only then. The bounds carve
  // [activationFloor, now) minus the counted rollup middle, so the aggregate reads
  // the activation-bucket segment and the uncompacted tail rather than the newest
  // rows the display query caps at. The range cards above keep the pure rollup
  // counts, since a range score reads only completed buckets.
  const tailBounds = firstRunPhase(activatedAt, now) === "collecting"
    ? rawTailBounds(activeRollups24h, activatedAt)
    : null;
  const rawTail = tailBounds ? await getRawTailCounts(id, tailBounds, now) : EMPTY_TAIL_COUNTS;
  const observedCollecting = observedWithRawTail(activeRollups24h, rawTail);
  const observed7d = summarizeCounts(rollupsSinceActivation(rollups7d, activatedAt));
  const observed30d = summarizeCounts(rollupsSinceActivation(rollups30d, activatedAt));
  const observed90d = summarizeCounts(rollupsSinceActivation(rollups90d, activatedAt));

  let acceptedConfig = null;
  try { acceptedConfig = accepted[0] ? validateMonitoringConfig(accepted[0].configJson) : null; } catch { acceptedConfig = null; }
  const config: MonitorConfig | undefined = acceptedConfig?.monitors.find((candidate) => candidate.id === id);
  const groupName = config?.groupId ? acceptedConfig?.groups.find((group) => group.id === config.groupId)?.name ?? monitor.group : null;
  const responsePoints = (rows: typeof rollups24h) => rows
    .filter((row) => row.latencyCount > 0)
    .map((row) => ({
      timestamp: row.bucketStart.toISOString(),
      latencyMs: Number(row.latencySumMs) / row.latencyCount,
      successful: row.failedChecks === 0 && row.completedChecks === row.expectedChecks,
    }));

  // Neutral timing context only, for the active or recently resolved
  // incident: never a causal claim. See Docs/DEPENDENCY-MONITORING.md
  // "Incident correlation".
  const latestIncidentRow = recentIncidents[0] && (
    recentIncidents[0].resolvedAt === null ||
    recentIncidents[0].resolvedAt.getTime() >= now.getTime() - 86_400_000
  ) ? recentIncidents[0] : null;
  const latestIncidentOverlaps = latestIncidentRow
    ? await listOverlappingDependencyIncidents({ openedAt: latestIncidentRow.openedAt, resolvedAt: latestIncidentRow.resolvedAt })
    : [];
  // Origin's first-run refactor builds the incident through buildLatestIncident,
  // so attach the dependency overlaps onto that result rather than the removed
  // hand-built object. Overlaps ride the detail snapshot only, the live poll
  // stays lean, and a full refresh recomputes them.
  const builtLatestIncident = buildLatestIncident(recentIncidents, now);
  const latestIncidentWithOverlaps = builtLatestIncident
    ? { ...builtLatestIncident, overlaps: latestIncidentOverlaps }
    : null;

  return {
    id: monitor.id,
    name: monitor.name,
    url: monitor.url,
    method: config?.method ?? DEFAULT_MONITOR_VALUES.method,
    groupId: config?.groupId ?? null,
    group: groupName,
    enabled: config?.enabled ?? monitor.enabled,
    intervalMinutes: config?.intervalMinutes ?? DEFAULT_MONITOR_VALUES.intervalMinutes,
    timeoutMs: config?.timeoutMs ?? DEFAULT_MONITOR_VALUES.timeoutMs,
    recipients: config?.recipients ?? [],
    state: monitor.state ?? "PENDING",
    intervalSeconds: (config?.intervalMinutes ?? DEFAULT_MONITOR_VALUES.intervalMinutes) * 60,
    timeoutSeconds: (config?.timeoutMs ?? DEFAULT_MONITOR_VALUES.timeoutMs) / 1_000,
    expectedStatusMin: config?.expectedStatus.minimum ?? DEFAULT_MONITOR_VALUES.expectedStatus.minimum,
    expectedStatusMax: config?.expectedStatus.maximum ?? DEFAULT_MONITOR_VALUES.expectedStatus.maximum,
    failureThreshold: config?.failureThreshold ?? DEFAULT_MONITOR_VALUES.failureThreshold,
    recoveryThreshold: config?.recoveryThreshold ?? DEFAULT_MONITOR_VALUES.recoveryThreshold,
    recipientCount: config
      ? (config.recipients.length || (acceptedConfig?.settings.defaultRecipients.length ?? 0))
      : 0,
    latestLatencyMs: monitor.latestLatencyMs,
    lastCheckedAt: monitor.lastCheckedAt?.toISOString() ?? null,
    // Latency reads the same activation-filtered rollups uptime does, so a slow
    // or failing setup check never degrades the header p95 after the first-run
    // UI hides its bucket.
    p95LatencyMs: p95Latency(rollupsSinceActivation(rollups24h, activatedAt)),
    uptime: {
      h24: observed24h.uptime,
      d7: observed7d.uptime,
      d30: observed30d.uptime,
      d90: observed90d.uptime,
    },
    coverage: {
      h24: observed24h.coverage,
      d7: observed7d.coverage,
      d30: observed30d.coverage,
      d90: observed90d.coverage,
    },
    rangeUnlocked: {
      h24: isRangeUnlocked("h24", activatedAt, end15m),
      d7: isRangeUnlocked("d7", activatedAt, end15m),
      d30: isRangeUnlocked("d30", activatedAt, endHour),
      d90: isRangeUnlocked("d90", activatedAt, endDay),
    } satisfies Record<AvailabilityRange, boolean>,
    firstRun: buildFirstRun(monitor, observedCollecting, now),
    rollupVersion: rollupVersionOf(rollups7d),
    // The accepted snapshot governs every field the config drives above, so its
    // acceptedAt is the opaque change token the live poll watches to land an
    // out-of-band config edit on a paused monitor whose rollup version never advances.
    acceptedConfigToken: accepted[0]?.acceptedAt?.toISOString() ?? null,
    // The completed 15-minute boundary the h24 and d7 scores read against. The
    // live poll watches it to refresh the timeline and response chart once when
    // the window slides, even on a paused monitor whose rollup version is fixed.
    windowVersion: end15m.toISOString(),
    // Timeline bars read the same activation-filtered rollups the uptime
    // figures do, so pre-activation buckets render as no-data rather than red
    // down bars while the header still reads as collecting or setup.
    availability: {
      h24: {
        start: new Date(end15m.getTime() - 86_400_000).toISOString(),
        buckets: buildRollupTimeline(rollupsSinceActivation(rollups24h, activatedAt), 60, 86_400_000, end15m),
      },
      d7: {
        start: new Date(end15m.getTime() - 7 * 86_400_000).toISOString(),
        buckets: buildRollupTimeline(rollupsSinceActivation(rollups7d, activatedAt), 84, 7 * 86_400_000, end15m),
      },
      d30: {
        start: new Date(endHour.getTime() - 30 * 86_400_000).toISOString(),
        buckets: buildRollupTimeline(rollupsSinceActivation(rollups30d, activatedAt), 90, 30 * 86_400_000, endHour),
      },
      d90: {
        start: new Date(endDay.getTime() - 90 * 86_400_000).toISOString(),
        buckets: buildRollupTimeline(rollupsSinceActivation(rollups90d, activatedAt), 90, 90 * 86_400_000, endDay),
      },
    },
    // The response chart draws from activation-filtered rollups in every window
    // so setup-phase latency points never trail into the series the rest of the
    // first-run UI has hidden.
    responseTime: {
      h24: responsePoints(rollupsSinceActivation(rollups24h, activatedAt)),
      d7: responsePoints(rollupsSinceActivation(rollups7d, activatedAt)),
      d30: responsePoints(rollupsSinceActivation(rollups30d, activatedAt)),
    },
    latestIncident: latestIncidentWithOverlaps,
    recentIncidents: buildRecentIncidents(recentIncidents, now),
    // Recent Checks hide pre-activation setup minutes the same way uptime,
    // timelines, latency, and incidents do. The raw path filters to checks at or
    // after activation, and the rollup fallback reuses rollupsSinceActivation, so
    // a null activation yields an empty list rather than the setup failures the
    // setup card already surfaces.
    recentChecks: activeRawChecks.length > 0
      ? buildRecentChecksFromRaw(activeRawChecks)
      : buildRecentChecks(rollupsSinceActivation(rollups24h, activatedAt)),
  };
}

// Lean payload for the live poll. It fetches the 7d 15-minute rollups plus
// the raw recent checks, enough for the h24 and d7 uptime and coverage, the
// recent checks, and the rollup version. The d30 and d90 figures are absent,
// so the client keeps the
// snapshot values that refresh through the rollup-version-gated router.refresh.
// It skips the config snapshot, the timeline buckets, and the response chart
// series that the full detail query builds. Locked ranges report null so an
// API consumer cannot read partial history as a full-range score. The incident
// fields carry incident detail, so a caller without incidents:read receives a
// null latestIncident and an empty recentIncidents and the query never reads
// the incidents table. Dashboard sessions hold both scopes and see them.
export async function getMonitorLive(
  id: string,
  options: { includeIncidents?: boolean } = {},
): Promise<MonitorLiveData | null> {
  const includeIncidents = options.includeIncidents ?? true;
  const monitor = await getMonitorIdentity(id);
  if (!monitor) return null;

  // First-run model. Uptime, coverage, latency, and incidents count only data
  // at or after activation, so setup-phase failures never define the monitor. A
  // monitor with no activation surfaces no incidents at all.
  const activatedAt = monitor.activatedAt;
  const now = new Date();
  const end15m = completedRangeEnd(now, "15m");
  const endHour = completedRangeEnd(now, "hour");
  const endDay = completedRangeEnd(now, "day");
  const [rollups7d, recentIncidents, recentRawChecks, accepted] = await Promise.all([
    fetchRollups(id, "15m", end15m, 7 * 86_400_000),
    includeIncidents && activatedAt !== null
      ? db.select().from(incidents)
          .where(and(eq(incidents.monitorId, id), gte(incidents.openedAt, activatedAt)))
          .orderBy(desc(incidents.openedAt))
          .limit(5)
      : Promise.resolve([]),
    getRecentRawChecks(id, now),
    // Accepted config token only. This one-column single-row read rides the
    // accepted snapshot index and skips the configJson decode the detail query
    // runs, so the poll stays lean while still carrying the signal that lands an
    // out-of-band config edit on a paused monitor.
    db.select({ acceptedAt: monitoringConfigSnapshots.acceptedAt })
      .from(monitoringConfigSnapshots)
      .where(eq(monitoringConfigSnapshots.status, "accepted"))
      .orderBy(desc(monitoringConfigSnapshots.acceptedAt))
      .limit(1),
  ]);

  const rollups24h = selectRecentRollupWindow(rollups7d, end15m.getTime() - 86_400_000, end15m.getTime());
  const activeRawChecks = rawChecksSinceActivation(recentRawChecks, activatedAt);
  const activeRollups24h = rollupsSinceActivation(rollups24h, activatedAt);
  const observed24h = summarizeCounts(activeRollups24h);
  // The collecting card folds the raw minutes no rollup counts onto the completed
  // rollups so the live poll matches the detail snapshot. Only the collecting
  // phase renders that card, so the raw aggregate runs only then, over
  // [activationFloor, now) minus the counted rollup middle. The range cards below
  // keep the pure rollup counts, since a range score reads only completed buckets.
  const tailBounds = firstRunPhase(activatedAt, now) === "collecting"
    ? rawTailBounds(activeRollups24h, activatedAt)
    : null;
  const rawTail = tailBounds ? await getRawTailCounts(id, tailBounds, now) : EMPTY_TAIL_COUNTS;
  const observedCollecting = observedWithRawTail(activeRollups24h, rawTail);
  const observed7d = summarizeCounts(rollupsSinceActivation(rollups7d, activatedAt));
  const unlocked24h = isRangeUnlocked("h24", activatedAt, end15m);
  const unlocked7d = isRangeUnlocked("d7", activatedAt, end15m);

  return {
    // The payload names its monitor so the client merges it only under the
    // matching page. SWR keepPreviousData holds one monitor's payload under the
    // next monitor's key across a direct navigation.
    id: monitor.id,
    state: monitor.state ?? "PENDING",
    // enabled tracks the registry row, which registry-sync flips in step with
    // the state field above, so a pause from another session lands here on the
    // next poll rather than waiting for a rollup refresh.
    enabled: monitor.enabled,
    latestLatencyMs: monitor.latestLatencyMs,
    lastCheckedAt: monitor.lastCheckedAt?.toISOString() ?? null,
    // Latency reads the same activation-filtered rollups uptime does, so a slow
    // or failing setup check never degrades the header p95 after the first-run
    // UI hides its bucket.
    p95LatencyMs: p95Latency(rollupsSinceActivation(rollups24h, activatedAt)),
    uptime: {
      h24: unlocked24h ? observed24h.uptime : null,
      d7: unlocked7d ? observed7d.uptime : null,
    },
    coverage: {
      h24: unlocked24h ? observed24h.coverage : null,
      d7: unlocked7d ? observed7d.coverage : null,
    },
    rangeUnlocked: {
      h24: unlocked24h,
      d7: unlocked7d,
      d30: isRangeUnlocked("d30", activatedAt, endHour),
      d90: isRangeUnlocked("d90", activatedAt, endDay),
    },
    firstRun: buildFirstRun(monitor, observedCollecting, now),
    latestIncident: buildLatestIncident(recentIncidents, now),
    recentIncidents: buildRecentIncidents(recentIncidents, now),
    // Recent Checks hide pre-activation setup minutes the same way uptime,
    // timelines, latency, and incidents do, so the live poll stays consistent
    // with the detail snapshot. A null activation yields an empty list.
    recentChecks: activeRawChecks.length > 0
      ? buildRecentChecksFromRaw(activeRawChecks)
      : buildRecentChecks(rollupsSinceActivation(rollups24h, activatedAt)),
    rollupVersion: rollupVersionOf(rollups7d),
    acceptedConfigToken: accepted[0]?.acceptedAt?.toISOString() ?? null,
    // The completed 15-minute boundary the h24 and d7 scores read against. The
    // client refreshes once when it advances so the server recomputes the
    // timeline and chart, even on a paused monitor whose rollup version is fixed.
    windowVersion: end15m.toISOString(),
  };
}
