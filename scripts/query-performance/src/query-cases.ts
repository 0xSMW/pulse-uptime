// Defines the benchmark query inventory. Production queries are reconstructed
// with the shared schema and gated connection. Modules that connect during
// import are avoided. Excluded paths are documented in `excludedQueries`.

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql as dsql } from "drizzle-orm";

import * as schema from "../../../lib/db/schema";
import { CLAIM_NOTIFICATIONS_SQL, RECONCILE_STALE_CLAIMS_SQL } from "../../../lib/notifications/sql";
import type { GatedConnection } from "./db-connection";
import type { SampleContext } from "./sample-context";

export interface ResolvedQuery {
  text: string;
  params: unknown[];
}

export interface QueryCase {
  name: string;
  description: string;
  source: string;
  /** Runs mutating cases in a transaction that always rolls back. */
  mutating: boolean;
  build: (conn: GatedConnection, ctx: SampleContext) => ResolvedQuery;
}

export interface ExcludedQuery {
  name: string;
  source: string;
  reason: string;
}

function toSQL(query: { toSQL(): { sql: string; params: unknown[] } }): ResolvedQuery {
  const built = query.toSQL();
  return { text: built.sql, params: built.params };
}

export const queryCases: QueryCase[] = [
  {
    name: "dashboard-monitors-uptime24h",
    description: "Dashboard monitor list with the rollup+raw-check blended 24h uptime subquery and the active-incident left join production performs alongside it.",
    source: "lib/monitoring/queries.ts:35-117 (listDashboardMonitors)",
    mutating: false,
    build: (conn, ctx) => {
      // Use fixture time so plans read seeded rollups.
      const end15m = new Date(ctx.now);
      end15m.setUTCMinutes(Math.floor(end15m.getUTCMinutes() / 15) * 15, 0, 0);
      const start15m = new Date(end15m.getTime() - 86_400_000);
      return toSQL(conn.db.select({
        id: schema.monitorRegistry.id,
        name: schema.monitorRegistry.name,
        url: schema.monitorRegistry.url,
        state: schema.monitorState.state,
        lastLatencyMs: schema.monitorState.lastLatencyMs,
        lastCheckedAt: schema.monitorState.lastCheckedAt,
        activeIncidentOpenedAt: schema.incidents.openedAt,
        uptime24h: dsql<number | null>`(
          select case when coalesce(rollup.completed, 0) + coalesce(raw.completed, 0) = 0 then null
            else 100.0 * (coalesce(rollup.successful, 0) + coalesce(raw.successful, 0))
              / (coalesce(rollup.completed, 0) + coalesce(raw.completed, 0)) end
          from (
            select sum(${schema.metricRollups.completedChecks}) as completed,
              sum(${schema.metricRollups.successfulChecks}) as successful
            from ${schema.metricRollups}
            where ${schema.metricRollups.monitorId} = ${schema.monitorRegistry.id}
              and ${schema.metricRollups.resolution} = '15m'
              and ${schema.metricRollups.bucketStart} >= ${start15m}
              and ${schema.metricRollups.bucketStart} < ${end15m}
          ) rollup
          cross join lateral (
            select count(*) as completed,
              count(*) filter (where ${schema.checkResults.successful}) as successful
            from ${schema.checkResults}
            where ${schema.checkResults.monitorId} = ${schema.monitorRegistry.id}
              and ${schema.checkResults.checkedAt} >= ${start15m}
              and not exists (
                select 1 from ${schema.metricRollups} covered
                where covered.monitor_id = ${schema.monitorRegistry.id}
                  and covered.resolution = '15m'
                  and covered.bucket_start = date_bin('15 minutes', ${schema.checkResults.checkedAt}, timestamptz '2000-01-01')
              )
          ) raw
        )`,
      }).from(schema.monitorRegistry)
        .leftJoin(schema.monitorState, eq(schema.monitorState.monitorId, schema.monitorRegistry.id))
        .leftJoin(
          schema.incidents,
          and(eq(schema.incidents.monitorId, schema.monitorRegistry.id), isNull(schema.incidents.resolvedAt)),
        )
        .where(isNull(schema.monitorRegistry.archivedAt)));
    },
  },
  {
    name: "command-palette-monitors",
    description: "Slim monitor projection for the command palette (no rollup join).",
    source: "lib/monitoring/queries.ts:16-33 (listCommandPaletteMonitors)",
    mutating: false,
    build: (conn) => toSQL(conn.db.select({
      id: schema.monitorRegistry.id,
      name: schema.monitorRegistry.name,
      state: schema.monitorState.state,
      lastLatencyMs: schema.monitorState.lastLatencyMs,
    }).from(schema.monitorRegistry)
      .leftJoin(schema.monitorState, eq(schema.monitorState.monitorId, schema.monitorRegistry.id))
      .where(isNull(schema.monitorRegistry.archivedAt))),
  },
  {
    name: "monitor-identity-lookup",
    description: "Single monitor identity lookup by primary key, joined to current state.",
    source: "lib/reporting/queries/monitors.ts:getMonitorIdentity",
    mutating: false,
    build: (conn, ctx) => toSQL(conn.db.select({
      id: schema.monitorRegistry.id,
      name: schema.monitorRegistry.name,
      url: schema.monitorRegistry.url,
      state: schema.monitorState.state,
      latestLatencyMs: schema.monitorState.lastLatencyMs,
    }).from(schema.monitorRegistry)
      .leftJoin(schema.monitorState, eq(schema.monitorState.monitorId, schema.monitorRegistry.id))
      .where(and(eq(schema.monitorRegistry.id, ctx.monitorIds[0]!), isNull(schema.monitorRegistry.archivedAt)))
      .limit(1)),
  },
  ...(["15m", "hour", "day"] as const).flatMap((resolution) => {
    // Scan windows match production. The 15m query scans seven days before
    // deriving the 24h view from those results.
    const windowsByResolution: Record<typeof resolution, { label: string; durationMs: number }> = {
      "15m": { label: "7d", durationMs: 7 * 86_400_000 },
      hour: { label: "30d", durationMs: 30 * 86_400_000 },
      day: { label: "90d", durationMs: 90 * 86_400_000 },
    };
    const window = windowsByResolution[resolution];
    return [{
      name: `monitor-detail-rollups-${window.label}`,
      description: resolution === "15m"
        ? "Monitor detail page 15m-resolution rollup scan over the actual 7-day window rollupsFor() issues; production derives its 24h view in-memory from this superset instead of querying it separately."
        : `Monitor detail page rollup series at ${resolution} resolution over a ${window.label} window.`,
      source: "lib/reporting/queries/monitors.ts:121-134 (rollupsFor call sites in getMonitorDetail)",
      mutating: false,
      build: (conn: GatedConnection, ctx: SampleContext) => {
        const end = new Date(ctx.now);
        if (resolution === "day") end.setUTCHours(0, 0, 0, 0);
        else if (resolution === "hour") end.setUTCMinutes(0, 0, 0);
        else end.setUTCMinutes(Math.floor(end.getUTCMinutes() / 15) * 15, 0, 0);
        return toSQL(conn.db.select({
          bucketStart: schema.metricRollups.bucketStart,
          expectedChecks: schema.metricRollups.expectedChecks,
          completedChecks: schema.metricRollups.completedChecks,
          successfulChecks: schema.metricRollups.successfulChecks,
          failedChecks: schema.metricRollups.failedChecks,
          latencyCount: schema.metricRollups.latencyCount,
          latencySumMs: schema.metricRollups.latencySumMs,
          latencyHistogram: schema.metricRollups.latencyHistogram,
        }).from(schema.metricRollups)
          .where(and(
            eq(schema.metricRollups.monitorId, ctx.monitorIds[0]!),
            eq(schema.metricRollups.resolution, resolution),
            gte(schema.metricRollups.bucketStart, new Date(end.getTime() - window.durationMs)),
            lt(schema.metricRollups.bucketStart, end),
          ))
          .orderBy(asc(schema.metricRollups.bucketStart)));
      },
    }];
  }),
  {
    name: "monitor-detail-recent-incidents",
    description: "Most recent 5 incidents for a single monitor's detail page.",
    source: "lib/reporting/queries/monitors.ts:getMonitorDetail",
    mutating: false,
    build: (conn, ctx) => {
      // Use the seeded incident owner when available.
      const monitorId = ctx.incidentMonitorId ?? ctx.monitorIds[0]!;
      return toSQL(conn.db.select().from(schema.incidents)
        .where(eq(schema.incidents.monitorId, monitorId))
        .orderBy(desc(schema.incidents.openedAt))
        .limit(5));
    },
  },
  {
    name: "monitor-detail-accepted-config",
    description: "Latest accepted monitoring config snapshot lookup.",
    source: "lib/reporting/queries/monitors.ts:getMonitorDetail",
    mutating: false,
    build: (conn) => toSQL(conn.db.select({ configJson: schema.monitoringConfigSnapshots.configJson })
      .from(schema.monitoringConfigSnapshots)
      .where(eq(schema.monitoringConfigSnapshots.status, "accepted"))
      .orderBy(desc(schema.monitoringConfigSnapshots.acceptedAt))
      .limit(1)),
  },
  {
    name: "incidents-list-all",
    description: "Incident list page, unfiltered, most recent 100.",
    source: "lib/reporting/queries/incidents.ts:listIncidents",
    mutating: false,
    build: (conn) => toSQL(conn.db.select({
      id: schema.incidents.id,
      monitorId: schema.incidents.monitorId,
      monitorName: schema.monitorRegistry.name,
      openedAt: schema.incidents.openedAt,
      resolvedAt: schema.incidents.resolvedAt,
    }).from(schema.incidents)
      .innerJoin(schema.monitorRegistry, eq(schema.monitorRegistry.id, schema.incidents.monitorId))
      .orderBy(desc(schema.incidents.openedAt))
      .limit(100)),
  },
  {
    name: "incidents-list-ongoing",
    description: "Incident list page filtered to ongoing incidents.",
    source: "lib/reporting/queries/incidents.ts:listIncidents",
    mutating: false,
    build: (conn) => toSQL(conn.db.select({
      id: schema.incidents.id,
      monitorId: schema.incidents.monitorId,
      monitorName: schema.monitorRegistry.name,
      openedAt: schema.incidents.openedAt,
    }).from(schema.incidents)
      .innerJoin(schema.monitorRegistry, eq(schema.monitorRegistry.id, schema.incidents.monitorId))
      .where(isNull(schema.incidents.resolvedAt))
      .orderBy(desc(schema.incidents.openedAt))
      .limit(100)),
  },
  {
    name: "incidents-notification-summary",
    description: "Bulk sent/dead/unsent aggregate for a page of incidents (avoids N+1 outbox scans).",
    source: "lib/reporting/queries/incidents.ts:listIncidents",
    mutating: false,
    build: (conn, ctx) => {
      // Bind every listed incident ID, or a sentinel for an empty page.
      const incidentIds = ctx.incidentIds.length > 0
        ? ctx.incidentIds
        : ["00000000-0000-0000-0000-000000000000"];
      return toSQL(conn.db.select({
        incidentId: schema.notificationOutbox.incidentId,
        sentCount: dsql<number>`count(*) filter (where ${schema.notificationOutbox.status} = 'sent')`.mapWith(Number),
        anyDead: dsql<boolean>`bool_or(${schema.notificationOutbox.status} = 'dead')`,
        anyUnsent: dsql<boolean>`bool_or(${schema.notificationOutbox.status} <> 'sent')`,
      }).from(schema.notificationOutbox)
        .where(inArray(schema.notificationOutbox.incidentId, incidentIds))
        .groupBy(schema.notificationOutbox.incidentId));
    },
  },
  {
    name: "incident-detail-lookup",
    description: "Single incident detail row, joined to monitor name.",
    source: "lib/reporting/queries/incidents.ts:getIncidentDetail",
    mutating: false,
    build: (conn, ctx) => toSQL(conn.db.select({
      id: schema.incidents.id,
      monitorId: schema.incidents.monitorId,
      monitorName: schema.monitorRegistry.name,
      openedAt: schema.incidents.openedAt,
      resolvedAt: schema.incidents.resolvedAt,
    }).from(schema.incidents)
      .innerJoin(schema.monitorRegistry, eq(schema.monitorRegistry.id, schema.incidents.monitorId))
      .where(eq(schema.incidents.id, ctx.ongoingIncidentId ?? ctx.resolvedIncidentId ?? "00000000-0000-0000-0000-000000000000"))
      .limit(1)),
  },
  {
    name: "incident-detail-notifications",
    description: "Notification timeline rows for a single incident's detail page.",
    source: "lib/reporting/queries/incidents.ts:getIncidentDetail",
    mutating: false,
    build: (conn, ctx) => toSQL(conn.db.select({
      eventType: schema.notificationOutbox.eventType,
      status: schema.notificationOutbox.status,
      createdAt: schema.notificationOutbox.createdAt,
      sentAt: schema.notificationOutbox.sentAt,
    }).from(schema.notificationOutbox)
      .where(eq(schema.notificationOutbox.incidentId, ctx.ongoingIncidentId ?? ctx.resolvedIncidentId ?? "00000000-0000-0000-0000-000000000000"))
      .orderBy(asc(schema.notificationOutbox.createdAt))
      .limit(40)),
  },
  {
    name: "public-status-monitors",
    description: "Public status page: enabled, non-archived monitors, capped at 100.",
    source: "lib/reporting/queries/status.ts:loadPublicStatus",
    mutating: false,
    build: (conn) => toSQL(conn.db.select({
      id: schema.monitorRegistry.id,
      name: schema.monitorRegistry.name,
      groupName: schema.monitorRegistry.groupName,
      state: schema.monitorState.state,
    }).from(schema.monitorRegistry)
      .leftJoin(schema.monitorState, eq(schema.monitorState.monitorId, schema.monitorRegistry.id))
      .where(and(eq(schema.monitorRegistry.enabled, true), isNull(schema.monitorRegistry.archivedAt)))
      .limit(100)),
  },
  {
    name: "public-status-rollups-90d",
    description: "Public status page: day-resolution rollups across up to 100 monitors over 90 days.",
    source: "lib/reporting/queries/status.ts:loadPublicStatus",
    mutating: false,
    build: (conn, ctx) => {
      const completedDay = new Date(ctx.now);
      completedDay.setUTCHours(0, 0, 0, 0);
      const earliest = new Date(completedDay.getTime() - 90 * 86_400_000);
      return toSQL(conn.db.select({
        monitorId: schema.metricRollups.monitorId,
        bucketStart: schema.metricRollups.bucketStart,
        expectedChecks: schema.metricRollups.expectedChecks,
        completedChecks: schema.metricRollups.completedChecks,
        successfulChecks: schema.metricRollups.successfulChecks,
        downtimeSeconds: schema.metricRollups.downtimeSeconds,
      }).from(schema.metricRollups)
        .where(and(
          inArray(schema.metricRollups.monitorId, ctx.monitorIds),
          eq(schema.metricRollups.resolution, "day"),
          gte(schema.metricRollups.bucketStart, earliest),
          lt(schema.metricRollups.bucketStart, completedDay),
        ))
        .orderBy(asc(schema.metricRollups.bucketStart))
        .limit(9_000));
    },
  },
  {
    name: "public-status-current-incidents",
    description: "Public status page: currently-open incidents across the visible monitor set.",
    source: "lib/reporting/queries/status.ts:loadPublicStatus",
    mutating: false,
    build: (conn, ctx) => toSQL(conn.db.select({
      id: schema.incidents.id,
      monitorName: schema.monitorRegistry.name,
      openedAt: schema.incidents.openedAt,
      openingStatusCode: schema.incidents.openingStatusCode,
    }).from(schema.incidents)
      .innerJoin(schema.monitorRegistry, eq(schema.monitorRegistry.id, schema.incidents.monitorId))
      .where(and(inArray(schema.incidents.monitorId, ctx.monitorIds), isNull(schema.incidents.resolvedAt)))
      .orderBy(desc(schema.incidents.openedAt))
      .limit(100)),
  },
  {
    name: "public-status-recent-incidents-resolved",
    description: "Public status page: 10 most recently resolved incidents across the visible monitor set.",
    source: "lib/reporting/queries/status.ts:loadPublicStatus",
    mutating: false,
    build: (conn, ctx) => toSQL(conn.db.select({
      id: schema.incidents.id,
      monitorName: schema.monitorRegistry.name,
      openedAt: schema.incidents.openedAt,
      resolvedAt: schema.incidents.resolvedAt,
    }).from(schema.incidents)
      .innerJoin(schema.monitorRegistry, eq(schema.monitorRegistry.id, schema.incidents.monitorId))
      .where(and(inArray(schema.incidents.monitorId, ctx.monitorIds), isNotNull(schema.incidents.resolvedAt)))
      .orderBy(desc(schema.incidents.resolvedAt))
      .limit(10)),
  },
  {
    name: "notification-outbox-claim",
    description: "Scheduler-style claim of due outbox rows with FOR UPDATE SKIP LOCKED.",
    source: "lib/notifications/sql.ts:CLAIM_NOTIFICATIONS_SQL",
    mutating: true,
    build: (_conn, ctx) => ({
      text: CLAIM_NOTIFICATIONS_SQL,
      params: [ctx.now, 25, "00000000-0000-0000-0000-000000000000"],
    }),
  },
  {
    name: "notification-outbox-reconcile-stale",
    description: "Reconciliation sweep for outbox rows stuck in 'sending' past the stale-claim cutoff.",
    source: "lib/notifications/sql.ts:RECONCILE_STALE_CLAIMS_SQL",
    mutating: true,
    build: (_conn, ctx) => {
      const cutoff = new Date(ctx.now.getTime() - 5 * 60_000);
      const safeRetryCutoff = new Date(ctx.now.getTime() - (24 * 60 * 60_000 - 5 * 60_000));
      return { text: RECONCILE_STALE_CLAIMS_SQL, params: [ctx.now, cutoff, safeRetryCutoff] };
    },
  },
];

export const excludedQueries: ExcludedQuery[] = [
  {
    name: "scheduler-fill-gaps",
    source: "lib/storage/sql.ts:FILL_SCHEDULER_GAPS_SQL",
    reason: "Multi-CTE maintenance query whose correctness depends on bit-packed check_batches state built up minute-by-minute by the live scheduler; synthetic params risk producing a misleading plan (or none) without duplicating that runtime logic here.",
  },
  {
    name: "scheduler-compact-15-minute",
    source: "lib/storage/sql.ts:COMPACT_15_MINUTE_SQL",
    reason: "Same bit-packed check_batches coupling as scheduler-fill-gaps — the bitmap decode logic in the query only means something over batches the fixture doesn't reconstruct byte-for-byte.",
  },
  {
    name: "scheduler-promote-rollup",
    source: "lib/storage/sql.ts:PROMOTE_ROLLUP_SQL",
    reason: "Depends on an upstream compaction pass having produced a specific bucket history; benchmarking it in isolation from scheduler-compact-15-minute would measure an unrepresentative input shape.",
  },
  {
    name: "auth-login-password-verify",
    source: "lib/auth/service.ts",
    reason: "Dominated by argon2 hashing cost, not SQL; the DB portion is a trivial unique-indexed email lookup already covered in shape by monitor-identity-lookup.",
  },
  {
    name: "token-verification-lookup",
    source: "lib/api/token-service.ts",
    reason: "Trivial unique-index point lookup on tokenDigest — same shape as monitor-identity-lookup, no incremental benchmarking value.",
  },
  {
    name: "rate-limit-increment",
    source: "lib/api/rate-limit.ts",
    reason: "Single-row upsert on a composite PK that mutates a counter every call; it's correctness-critical but not sensitive to the kind of query-shape optimization this hillclimb targets.",
  },
  {
    name: "idempotency-claim-upsert",
    source: "lib/api/idempotency.ts",
    reason: "Single-row upsert/point-lookup keyed by a unique index; same category as rate-limit-increment.",
  },
  {
    name: "notification-mark-sent-or-failed",
    source: "lib/notifications/sql.ts:MARK_NOTIFICATION_SENT_SQL / MARK_NOTIFICATION_FAILED_SQL",
    reason: "Single-row conditional update keyed by primary key + claim token; correctness-critical but not query-shape sensitive.",
  },
];
