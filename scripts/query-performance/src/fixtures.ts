// Builds and tears down the tagged representative fixture: 100 monitors plus
// the state/check/rollup/incident/outbox/config/auth/maintenance data that
// exercises the query inventory in query-cases.ts. Every row this module
// writes is namespaced under the "qh-" fixture tag (see fixture-constants.ts)
// so reset() only ever touches fixture-owned data, and verify-state.ts can
// prove the temp project holds exactly the cardinalities recorded here — no
// more, no less.

import { randomUUID, randomBytes } from "node:crypto";
import { sql as dsql } from "drizzle-orm";

import * as schema from "../../../lib/db/schema";
import type { GatedConnection } from "./db-connection";
import { mulberry32, pick, intBetween } from "./rng";
import {
  FIXTURE_EMAIL_DOMAIN,
  FIXTURE_URL_DOMAIN,
  FIXTURE_VERSION,
  GROUP_NAMES,
  MONITOR_COUNT,
  monitorId,
  monitorStateDistribution,
  type FixtureCardinalities,
} from "./fixture-constants";

const SEED = 0x51485f31; // 'QH_1' — fixed so fixture shape is reproducible.
const NOW = new Date();

const CHECK_INTERVAL_MINUTES = 1;
const CHECK_HISTORY_HOURS = 6;
const ROLLUP_15M_DAYS = 2;
const ROLLUP_HOUR_DAYS = 31;
const ROLLUP_DAY_DAYS = 91;
const DAILY_ROLLUP_DAYS = 30;
const SCHEDULER_BATCH_MINUTES = 60;
// metric_rollups is the widest fixture row at 18 columns, so 2,500 rows per
// insert binds 45,000 parameters -- comfortably under Postgres's 65,535
// per-statement limit while keeping insert-call counts low for the wider
// tables (see fixture-constants.test.ts for the budget assertion).
export const CHUNK_SIZE = 2_500;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function encodeBitmap(bits: boolean[]): Buffer {
  const buffer = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => {
    if (!bit) return;
    buffer[Math.floor(index / 8)]! |= 1 << (index % 8);
  });
  return buffer;
}

function encodeLatencies(values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeUInt32BE(value >>> 0, index * 4));
  return buffer;
}

interface MonitorPlan {
  id: string;
  name: string;
  url: string;
  groupName: string | null;
  enabled: boolean;
  state: (typeof schema.monitorStates)[number];
}

function buildMonitorPlan(): MonitorPlan[] {
  const rand = mulberry32(SEED);
  const states: MonitorPlan["state"][] = monitorStateDistribution.flatMap((entry) =>
    Array.from({ length: entry.count }, () => entry.state)
  );
  // Deterministic shuffle so state assignment doesn't correlate with index order.
  for (let index = states.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rand() * (index + 1));
    [states[index], states[swap]] = [states[swap]!, states[index]!];
  }
  return Array.from({ length: MONITOR_COUNT }, (_, zeroBased) => {
    const index = zeroBased + 1;
    const id = monitorId(index);
    const hasGroup = rand() > 0.08;
    return {
      id,
      name: `Fixture Monitor ${index}`,
      url: `https://${id}.${FIXTURE_URL_DOMAIN}/health`,
      groupName: hasGroup ? pick(rand, GROUP_NAMES) : null,
      enabled: states[zeroBased] !== "ARCHIVED",
      state: states[zeroBased]!,
    };
  });
}

async function resetFixtureData(conn: GatedConnection): Promise<void> {
  const { db } = conn;
  // Deletion order respects FK dependencies (no cascades except
  // atomic_minute_commits -> check_batches, which we still delete explicitly
  // for clarity and to keep this correct if that cascade is ever removed).
  await db.delete(schema.monitorExceptions).where(dsql`${schema.monitorExceptions.monitorId} like 'qh-%'`);
  await db.delete(schema.exceptionPayloads).where(dsql`true`);
  await db.delete(schema.notificationOutbox).where(dsql`${schema.notificationOutbox.monitorId} like 'qh-%'`);
  await db.delete(schema.incidents).where(dsql`${schema.incidents.monitorId} like 'qh-%'`);
  await db.delete(schema.checkResults).where(dsql`${schema.checkResults.monitorId} like 'qh-%'`);
  await db.delete(schema.metricRollups).where(dsql`${schema.metricRollups.monitorId} like 'qh-%'`);
  await db.delete(schema.dailyRollups).where(dsql`${schema.dailyRollups.monitorId} like 'qh-%'`);
  await db.delete(schema.monitorState).where(dsql`${schema.monitorState.monitorId} like 'qh-%'`);
  await db.delete(schema.atomicMinuteCommits).where(dsql`true`);
  await db.delete(schema.checkBatches).where(dsql`true`);
  await db.delete(schema.monitorRegistry).where(dsql`${schema.monitorRegistry.id} like 'qh-%'`);

  await db.delete(schema.monitoringConfigSnapshots).where(dsql`${schema.monitoringConfigSnapshots.source} = 'qh-fixture'`);
  await db.delete(schema.configChangeApprovals).where(dsql`${schema.configChangeApprovals.createdByPrincipal} = 'qh-fixture'`);
  await db.delete(schema.configOperations).where(dsql`${schema.configOperations.principalKey} = 'qh-fixture'`);
  await db.delete(schema.cronRuns).where(dsql`${schema.cronRuns.jobName} like 'qh-%'`);
  await db.delete(schema.jobLeases).where(dsql`${schema.jobLeases.name} like 'qh-%'`);
  await db.delete(schema.databaseUsageSnapshots).where(dsql`true`);

  await db.delete(schema.onboardingProgress).where(
    dsql`${schema.onboardingProgress.userId} in (select id from admin_users where email like '%@${dsql.raw(FIXTURE_EMAIL_DOMAIN)}')`,
  );
  await db.delete(schema.humanSessions).where(
    dsql`${schema.humanSessions.userId} in (select id from admin_users where email like '%@${dsql.raw(FIXTURE_EMAIL_DOMAIN)}')`,
  );
  await db.delete(schema.adminUsers).where(dsql`${schema.adminUsers.email} like ${"%@" + FIXTURE_EMAIL_DOMAIN}`);
  await db.delete(schema.apiTokens).where(dsql`${schema.apiTokens.name} like 'qh-%'`);
  await db.delete(schema.cliSessions).where(
    dsql`${schema.cliSessions.installationId} in (select id from cli_installations where installation_key like 'qh-%')`,
  );
  await db.delete(schema.cliInstallations).where(dsql`${schema.cliInstallations.installationKey} like 'qh-%'`);
  await db.delete(schema.deviceAuthorizations).where(dsql`${schema.deviceAuthorizations.installationKey} like 'qh-%'`);
  await db.delete(schema.apiIdempotency).where(dsql`${schema.apiIdempotency.principalKey} = 'qh-fixture'`);
  await db.delete(schema.apiRateLimitBuckets).where(dsql`${schema.apiRateLimitBuckets.principalKey} = 'qh-fixture'`);
}

async function insertMonitors(conn: GatedConnection, plan: MonitorPlan[]): Promise<void> {
  const { db } = conn;
  for (const rows of chunk(plan, CHUNK_SIZE)) {
    await db.insert(schema.monitorRegistry).values(rows.map((monitor) => ({
      id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      groupName: monitor.groupName,
      enabled: monitor.enabled,
      configHash: "qh-fixture-hash-v1",
      firstSeenAt: new Date(NOW.getTime() - 60 * 86_400_000),
      lastSeenAt: NOW,
      archivedAt: monitor.state === "ARCHIVED" ? new Date(NOW.getTime() - 86_400_000) : null,
    })));
  }

  const rand = mulberry32(SEED + 1);
  for (const rows of chunk(plan, CHUNK_SIZE)) {
    await db.insert(schema.monitorState).values(rows.map((monitor) => {
      const failing = monitor.state === "DOWN" || monitor.state === "VERIFYING_DOWN";
      return {
        monitorId: monitor.id,
        state: monitor.state,
        consecutiveFailures: failing ? intBetween(rand, 3, 12) : 0,
        consecutiveSuccesses: failing ? 0 : intBetween(rand, 5, 500),
        firstFailureAt: failing ? new Date(NOW.getTime() - 3_600_000) : null,
        firstSuccessAt: new Date(NOW.getTime() - 60 * 86_400_000),
        lastCheckedAt: monitor.state === "PENDING" ? null : NOW,
        lastSuccessAt: failing ? new Date(NOW.getTime() - 7_200_000) : NOW,
        lastFailureAt: failing ? NOW : new Date(NOW.getTime() - 30 * 86_400_000),
        lastStatusCode: failing ? pick(rand, [500, 502, 503]) : 200,
        lastLatencyMs: intBetween(rand, 40, 900),
        lastErrorCode: failing ? "TIMEOUT" : null,
        activeIncidentId: null,
        version: intBetween(rand, 0, 50),
        updatedAt: NOW,
      };
    }));
  }
}

interface IncidentPlan { id: string; monitorId: string; openedAt: Date; resolvedAt: Date | null; openingStatusCode: number | null; openingErrorCode: string | null; firstFailureAt: Date; firstSuccessAt: Date | null; }

async function insertChecksIncidentsAndOutbox(
  conn: GatedConnection,
  plan: MonitorPlan[],
): Promise<{ incidentCount: number; outboxCount: number; checkCount: number }> {
  const { db } = conn;
  const rand = mulberry32(SEED + 2);
  const checkCountPerMonitor = (CHECK_HISTORY_HOURS * 60) / CHECK_INTERVAL_MINUTES;
  let checkRows: (typeof schema.checkResults.$inferInsert)[] = [];
  const incidentPlans: IncidentPlan[] = [];
  let totalChecks = 0;

  for (const monitor of plan) {
    const failing = monitor.state === "DOWN" || monitor.state === "VERIFYING_DOWN";
    const failureRunLength = failing ? intBetween(rand, 4, 15) : 0;
    for (let step = checkCountPerMonitor; step >= 1; step -= 1) {
      const scheduledAt = new Date(NOW.getTime() - step * CHECK_INTERVAL_MINUTES * 60_000);
      const isTailFailure = failing && step <= failureRunLength;
      const randomBlip = !failing && rand() < 0.02;
      const successful = !isTailFailure && !randomBlip;
      const statusCode = successful ? 200 : pick(rand, [500, 502, 503, 522]);
      checkRows.push({
        monitorId: monitor.id,
        runId: randomUUID(),
        scheduledAt,
        checkedAt: new Date(scheduledAt.getTime() + intBetween(rand, 50, 400)),
        successful,
        statusCode: successful || rand() > 0.3 ? statusCode : null,
        latencyMs: successful ? intBetween(rand, 30, 400) : intBetween(rand, 500, 5_000),
        effectiveUrl: monitor.url,
        redirectCount: 0,
        resolvedAddress: "203.0.113." + intBetween(rand, 1, 254),
        errorCode: successful ? null : pick(rand, ["TIMEOUT", "CONNECTION_REFUSED", "DNS_ERROR"]),
        errorMessage: successful ? null : "qh-fixture synthetic failure",
        createdAt: scheduledAt,
      });
      totalChecks += 1;
    }

    if (failing) {
      const openedAt = new Date(NOW.getTime() - failureRunLength * CHECK_INTERVAL_MINUTES * 60_000);
      incidentPlans.push({
        id: randomUUID(),
        monitorId: monitor.id,
        openedAt,
        resolvedAt: null,
        openingStatusCode: 503,
        openingErrorCode: null,
        firstFailureAt: openedAt,
        firstSuccessAt: null,
      });
    } else if (rand() < 0.35) {
      const historicalCount = intBetween(rand, 1, 2);
      for (let historyIndex = 0; historyIndex < historicalCount; historyIndex += 1) {
        const daysAgo = intBetween(rand, 2, 55);
        const openedAt = new Date(NOW.getTime() - daysAgo * 86_400_000);
        const durationMinutes = intBetween(rand, 2, 180);
        const resolvedAt = new Date(openedAt.getTime() + durationMinutes * 60_000);
        incidentPlans.push({
          id: randomUUID(),
          monitorId: monitor.id,
          openedAt,
          resolvedAt,
          openingStatusCode: pick(rand, [500, 502, 503, null]),
          openingErrorCode: rand() < 0.3 ? "TIMEOUT" : null,
          firstFailureAt: openedAt,
          firstSuccessAt: resolvedAt,
        });
      }
    }

    if (checkRows.length >= CHUNK_SIZE * 4) {
      for (const rows of chunk(checkRows, CHUNK_SIZE)) await db.insert(schema.checkResults).values(rows);
      checkRows = [];
    }
  }
  for (const rows of chunk(checkRows, CHUNK_SIZE)) await db.insert(schema.checkResults).values(rows);

  for (const rows of chunk(incidentPlans, CHUNK_SIZE)) {
    await db.insert(schema.incidents).values(rows.map((incident) => ({
      id: incident.id,
      monitorId: incident.monitorId,
      openedAt: incident.openedAt,
      firstFailureAt: incident.firstFailureAt,
      lastFailureAt: incident.resolvedAt ? incident.openedAt : NOW,
      firstSuccessAt: incident.firstSuccessAt,
      resolvedAt: incident.resolvedAt,
      openingErrorCode: incident.openingErrorCode,
      openingStatusCode: incident.openingStatusCode,
      resolutionReason: incident.resolvedAt ? "recovered" : null,
      createdAt: incident.openedAt,
      updatedAt: incident.resolvedAt ?? incident.openedAt,
    })));
  }

  const outboxRows: (typeof schema.notificationOutbox.$inferInsert)[] = [];
  for (const incident of incidentPlans) {
    const events: { type: string; at: Date }[] = [{ type: "incident.opened", at: incident.openedAt }];
    if (incident.resolvedAt) events.push({ type: "incident.resolved", at: incident.resolvedAt });
    for (const event of events) {
      const statusRoll = rand();
      const status = statusRoll < 0.7 ? "sent" : statusRoll < 0.85 ? "pending" : statusRoll < 0.95 ? "failed" : "dead";
      outboxRows.push({
        id: randomUUID(),
        incidentId: incident.id,
        monitorId: incident.monitorId,
        eventType: event.type,
        recipient: `oncall@${FIXTURE_EMAIL_DOMAIN}`,
        idempotencyKey: `${incident.id}:${event.type}`,
        payload: { fixture: true, eventType: event.type },
        status,
        attemptCount: status === "sent" ? 1 : intBetween(rand, 0, 3),
        nextAttemptAt: status === "pending" || status === "failed" ? new Date(NOW.getTime() + 60_000) : event.at,
        claimToken: null,
        claimedAt: null,
        providerMessageId: status === "sent" ? `qh-fixture-msg-${randomUUID()}` : null,
        lastError: status === "failed" || status === "dead" ? "qh-fixture synthetic delivery failure" : null,
        sentAt: status === "sent" ? event.at : null,
        createdAt: event.at,
        updatedAt: event.at,
      });
    }
  }
  for (const rows of chunk(outboxRows, CHUNK_SIZE)) await db.insert(schema.notificationOutbox).values(rows);

  return { incidentCount: incidentPlans.length, outboxCount: outboxRows.length, checkCount: totalChecks };
}

function* bucketStarts(end: Date, count: number, stepMs: number): Generator<Date> {
  for (let index = count; index >= 1; index -= 1) yield new Date(end.getTime() - index * stepMs);
}

async function insertRollups(conn: GatedConnection, plan: MonitorPlan[]): Promise<{ metricRollupCount: number; dailyRollupCount: number }> {
  const { db } = conn;
  const rand = mulberry32(SEED + 3);
  const end15m = new Date(NOW);
  end15m.setUTCMinutes(Math.floor(end15m.getUTCMinutes() / 15) * 15, 0, 0);
  const endHour = new Date(NOW);
  endHour.setUTCMinutes(0, 0, 0);
  const endDay = new Date(NOW);
  endDay.setUTCHours(0, 0, 0, 0);

  function histogramFor(successRate: number): number[] {
    const buckets = [0, 0, 0, 0, 0, 0, 0, 0];
    const count = intBetween(rand, 4, 15);
    for (let index = 0; index < count; index += 1) {
      const bucketIndex = rand() < successRate ? intBetween(rand, 0, 2) : intBetween(rand, 3, 7);
      buckets[bucketIndex] += 1;
    }
    return buckets;
  }

  let metricRows: (typeof schema.metricRollups.$inferInsert)[] = [];
  let metricRollupCount = 0;
  const resolutions: { resolution: "15m" | "hour" | "day"; end: Date; days: number; stepMs: number }[] = [
    { resolution: "15m", end: end15m, days: ROLLUP_15M_DAYS, stepMs: 15 * 60_000 },
    { resolution: "hour", end: endHour, days: ROLLUP_HOUR_DAYS, stepMs: 3_600_000 },
    { resolution: "day", end: endDay, days: ROLLUP_DAY_DAYS, stepMs: 86_400_000 },
  ];
  for (const monitor of plan) {
    const healthy = monitor.state === "UP" || monitor.state === "PENDING";
    for (const { resolution, end, days, stepMs } of resolutions) {
      const bucketCount = resolution === "15m" ? days * 96 : resolution === "hour" ? days * 24 : days;
      for (const bucketStart of bucketStarts(end, bucketCount, stepMs)) {
        const expected = 1;
        const successRate = healthy ? 0.98 : 0.85;
        const successful = rand() < successRate ? 1 : 0;
        const histogram = histogramFor(successRate);
        const latencyCount = histogram.reduce((sum, value) => sum + value, 0);
        const latencySum = histogram.reduce((sum, value, index) => sum + value * [80, 200, 400, 800, 2000, 4000, 8000, 15000][index]!, 0);
        metricRows.push({
          monitorId: monitor.id,
          resolution,
          bucketStart,
          expectedChecks: expected,
          completedChecks: 1,
          successfulChecks: successful,
          failedChecks: 1 - successful,
          unknownChecks: 0,
          downtimeSeconds: successful ? 0 : Math.round(stepMs / 1000),
          unknownSeconds: 0,
          latencyCount,
          latencySumMs: BigInt(latencySum),
          latencyMinMs: latencyCount > 0 ? 80 : null,
          latencyMaxMs: latencyCount > 0 ? 15_000 : null,
          latencyHistogram: histogram,
          histogramVersion: 1,
          hasIncident: successful === 0,
          compactedAt: NOW,
        });
        metricRollupCount += 1;
      }
      if (metricRows.length >= CHUNK_SIZE * 4) {
        for (const rows of chunk(metricRows, CHUNK_SIZE)) await db.insert(schema.metricRollups).values(rows);
        metricRows = [];
      }
    }
  }
  for (const rows of chunk(metricRows, CHUNK_SIZE)) await db.insert(schema.metricRollups).values(rows);

  const dailyRows: (typeof schema.dailyRollups.$inferInsert)[] = [];
  let dailyRollupCount = 0;
  for (const monitor of plan) {
    const healthy = monitor.state === "UP" || monitor.state === "PENDING";
    for (const bucketStart of bucketStarts(endDay, DAILY_ROLLUP_DAYS, 86_400_000)) {
      const total = 96;
      const successful = healthy ? intBetween(rand, 92, 96) : intBetween(rand, 60, 90);
      const day = bucketStart.toISOString().slice(0, 10);
      dailyRows.push({
        monitorId: monitor.id,
        day,
        totalChecks: total,
        successfulChecks: successful,
        failedChecks: total - successful,
        uptimePercentage: ((successful / total) * 100).toFixed(4),
        averageLatencyMs: intBetween(rand, 60, 500),
        p50LatencyMs: intBetween(rand, 50, 300),
        p95LatencyMs: intBetween(rand, 200, 900),
        incidentSeconds: (total - successful) * 900,
      });
      dailyRollupCount += 1;
    }
  }
  for (const rows of chunk(dailyRows, CHUNK_SIZE)) await db.insert(schema.dailyRollups).values(rows);

  return { metricRollupCount, dailyRollupCount };
}

async function insertConfigAndOperations(conn: GatedConnection, plan: MonitorPlan[]): Promise<void> {
  const { db } = conn;
  const rand = mulberry32(SEED + 4);
  const groups = GROUP_NAMES.map((name) => ({ id: `qh-group-${name.toLowerCase().replace(/\s+/g, "-")}`, name }));
  const configJson = {
    version: 1,
    groups,
    settings: { defaultRecipients: [`oncall@${FIXTURE_EMAIL_DOMAIN}`] },
    monitors: plan.map((monitor) => ({
      id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      method: "GET",
      groupId: monitor.groupName ? `qh-group-${monitor.groupName.toLowerCase().replace(/\s+/g, "-")}` : null,
      enabled: monitor.enabled,
      intervalMinutes: pick(rand, [1, 5, 10, 15]),
      timeoutMs: 10_000,
      recipients: [],
      expectedStatus: { minimum: 200, maximum: 299 },
      failureThreshold: 2,
      recoveryThreshold: 2,
    })),
  };
  const acceptedAt = new Date(NOW.getTime() - 3_600_000);
  await db.insert(schema.monitoringConfigSnapshots).values([
    {
      id: randomUUID(),
      configVersion: 1,
      configHash: "qh-fixture-config-hash",
      configJson,
      status: "accepted",
      rejectionReason: null,
      source: "qh-fixture",
      seenAt: acceptedAt,
      acceptedAt,
    },
    {
      id: randomUUID(),
      configVersion: 0,
      configHash: "qh-fixture-config-hash-rejected",
      configJson: { ...configJson, monitors: [] },
      status: "rejected",
      rejectionReason: "qh-fixture synthetic rejection",
      source: "qh-fixture",
      seenAt: new Date(acceptedAt.getTime() - 3_600_000),
      acceptedAt: null,
    },
  ]);

  await db.insert(schema.configChangeApprovals).values([{
    id: randomUUID(),
    targetConfigHash: "qh-fixture-config-hash",
    action: "bulk_archive",
    createdByPrincipal: "qh-fixture",
    createdAt: new Date(NOW.getTime() - 1_800_000),
    expiresAt: new Date(NOW.getTime() + 1_800_000),
    consumedAt: null,
  }]);

  const operationRows = Array.from({ length: 10 }, (_, index) => ({
    id: randomUUID(),
    principalKey: "qh-fixture",
    requestId: `qh-fixture-req-${index}`,
    idempotencyKey: `qh-fixture-idem-${index}`,
    baseConfigHash: "qh-fixture-config-hash-base",
    targetConfigHash: "qh-fixture-config-hash",
    planHash: `qh-fixture-plan-${index}`,
    desiredConfig: configJson,
    diffJson: { fixture: true },
    state: pick(rand, ["written", "accepted", "rejected", "failed"] as const),
    edgeConfigVersion: index,
    rejectionReason: null,
    createdAt: new Date(NOW.getTime() - index * 600_000),
    writtenAt: new Date(NOW.getTime() - index * 600_000 + 1_000),
    acceptedAt: null,
    failedAt: null,
  }));
  await db.insert(schema.configOperations).values(operationRows);
}

export async function insertMaintenanceAndScheduler(conn: GatedConnection, plan: MonitorPlan[]): Promise<{ cronRunCount: number; checkBatchCount: number }> {
  const { db } = conn;
  const rand = mulberry32(SEED + 5);
  const activeMonitors = plan.filter((monitor) => monitor.enabled);

  const cronRows = Array.from({ length: 200 }, (_, index) => {
    const scheduledMinute = new Date(NOW.getTime() - index * 60_000);
    const status = index === 0 ? "running" : "completed";
    return {
      id: randomUUID(),
      jobName: "qh-fixture-monitor-check",
      scheduledMinute,
      status: status as "running" | "completed" | "failed",
      startedAt: scheduledMinute,
      completedAt: status === "completed" ? new Date(scheduledMinute.getTime() + 5_000) : null,
      monitorCount: activeMonitors.length,
      successCount: activeMonitors.length - 2,
      failureCount: 2,
      skippedCount: 0,
      errorMessage: null,
    };
  });
  for (const rows of chunk(cronRows, CHUNK_SIZE)) await db.insert(schema.cronRuns).values(rows);

  await db.insert(schema.jobLeases).values([{
    name: "qh-fixture-lease",
    ownerId: randomUUID(),
    leaseUntil: new Date(NOW.getTime() + 60_000),
    updatedAt: NOW,
  }]);

  const monitorIds = activeMonitors.map((monitor) => monitor.id);
  const expectedBitmap = encodeBitmap(monitorIds.map(() => true));
  const completedBitmap = encodeBitmap(monitorIds.map(() => true));
  const failureBitmap = encodeBitmap(monitorIds.map(() => false));

  const checkBatchRows: (typeof schema.checkBatches.$inferInsert)[] = [];
  const commitRows: (typeof schema.atomicMinuteCommits.$inferInsert)[] = [];
  for (let minute = SCHEDULER_BATCH_MINUTES; minute >= 1; minute -= 1) {
    const scheduledMinute = new Date(NOW.getTime() - minute * 60_000);
    const latencyValues = encodeLatencies(monitorIds.map(() => intBetween(rand, 30, 900)));
    checkBatchRows.push({
      scheduledMinute,
      encodingVersion: 1,
      configVersion: 1,
      monitorIds,
      expectedBitmap,
      completedBitmap,
      failureBitmap,
      latencyValues,
      schedulerStartedAt: scheduledMinute,
      schedulerCompletedAt: new Date(scheduledMinute.getTime() + 3_000),
      createdAt: scheduledMinute,
    });
    commitRows.push({
      scheduledMinute,
      stateMutationCount: monitorIds.length,
      committedAt: new Date(scheduledMinute.getTime() + 3_500),
    });
  }
  // atomic_minute_commits.scheduled_minute FKs to check_batches, so the batch
  // rows must land first — but each table still gets its own chunked insert
  // pass rather than one round trip per minute.
  for (const rows of chunk(checkBatchRows, CHUNK_SIZE)) await db.insert(schema.checkBatches).values(rows);
  for (const rows of chunk(commitRows, CHUNK_SIZE)) await db.insert(schema.atomicMinuteCommits).values(rows);
  const checkBatchCount = checkBatchRows.length;

  const usageSnapshots = Array.from({ length: 30 }, (_, index) => {
    const capturedAt = new Date(NOW.getTime() - index * 86_400_000);
    const storageBytes = BigInt(500_000_000 + index * 2_000_000);
    return {
      capturedAt,
      storageBytes,
      indexBytes: storageBytes / 4n,
      categoryBytes: { rollups: Number(storageBytes) * 0.4, coreData: Number(storageBytes) * 0.2 },
      historyBytes: storageBytes / 2n,
      monthlyTransferBytes: storageBytes,
      projected30DayBytes: storageBytes + storageBytes / 10n,
      governorMode: "full" as const,
      lastCompactionAt: capturedAt,
      schedulerCoverage: "0.9950",
      providerMetricsCapturedAt: capturedAt,
    };
  });
  for (const rows of chunk(usageSnapshots, CHUNK_SIZE)) await db.insert(schema.databaseUsageSnapshots).values(rows);

  return { cronRunCount: cronRows.length, checkBatchCount };
}

async function insertExceptionsAndAuth(conn: GatedConnection, plan: MonitorPlan[]): Promise<{ exceptionCount: number; adminCount: number }> {
  const { db } = conn;
  const rand = mulberry32(SEED + 6);
  const failingMonitors = plan.filter((monitor) => monitor.state === "DOWN" || monitor.state === "VERIFYING_DOWN");

  const payloadRows = failingMonitors.map((monitor) => ({
    id: randomUUID(),
    payload: { fixture: true, monitorId: monitor.id },
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 30 * 86_400_000),
  }));
  if (payloadRows.length > 0) await db.insert(schema.exceptionPayloads).values(payloadRows);

  const exceptionRows = failingMonitors.map((monitor, index) => ({
    id: randomUUID(),
    monitorId: monitor.id,
    eventType: "failure" as const,
    errorCode: "TIMEOUT",
    identityHash: randomBytes(16),
    firstSeenAt: new Date(NOW.getTime() - 3_600_000),
    lastSeenAt: NOW,
    occurrenceCount: intBetween(rand, 1, 20),
    worstLatencyMs: intBetween(rand, 1_000, 9_000),
    incidentId: null,
    payloadId: payloadRows[index]?.id ?? null,
  }));
  if (exceptionRows.length > 0) await db.insert(schema.monitorExceptions).values(exceptionRows);

  // Auth/CLI fixture principals: digests are random bytes with no
  // corresponding plaintext anywhere, so these can never authenticate as any
  // real account even though they satisfy the schema's NOT NULL/UNIQUE shape.
  const adminIds = [randomUUID(), randomUUID()];
  await db.insert(schema.adminUsers).values(adminIds.map((id, index) => ({
    id,
    email: `admin-${index}@${FIXTURE_EMAIL_DOMAIN}`,
    passwordDigest: `qh-fixture-not-a-real-digest-${randomBytes(8).toString("hex")}`,
    createdAt: new Date(NOW.getTime() - 90 * 86_400_000),
    updatedAt: NOW,
    passwordChangedAt: new Date(NOW.getTime() - 30 * 86_400_000),
    onboardingCompletedAt: index === 0 ? new Date(NOW.getTime() - 89 * 86_400_000) : null,
  })));

  await db.insert(schema.humanSessions).values(adminIds.map((userId) => ({
    id: randomUUID(),
    userId,
    tokenDigest: randomBytes(32),
    createdAt: new Date(NOW.getTime() - 3_600_000),
    expiresAt: new Date(NOW.getTime() + 6 * 3_600_000),
    lastSeenAt: NOW,
    revokedAt: null,
  })));

  await db.insert(schema.onboardingProgress).values([{
    userId: adminIds[1]!,
    currentStep: "add-monitor",
    draftMonitor: null,
    emailWarningAcknowledged: false,
    updatedAt: NOW,
    completedAt: null,
  }]);

  await db.insert(schema.apiTokens).values(Array.from({ length: 3 }, (_, index) => ({
    id: randomUUID(),
    name: `qh-fixture-token-${index}`,
    tokenPrefix: `qhfx${index}`,
    tokenDigest: randomBytes(32),
    principalType: "admin",
    principalId: adminIds[0]!,
    scopes: ["monitors:read"],
    createdAt: new Date(NOW.getTime() - 10 * 86_400_000),
    createdByPrincipal: "qh-fixture",
    expiresAt: new Date(NOW.getTime() + 300 * 86_400_000),
    lastUsedAt: NOW,
    revokedAt: null,
  })));

  const installationIds = [randomUUID(), randomUUID()];
  await db.insert(schema.cliInstallations).values(installationIds.map((id, index) => ({
    id,
    installationKey: `qh-fixture-install-${index}`,
    userEmail: `admin-${index % 2}@${FIXTURE_EMAIL_DOMAIN}`,
    displayName: `qh-fixture-cli-${index}`,
    platform: "linux",
    architecture: "x64",
    clientVersion: "0.0.0-fixture",
    createdAt: new Date(NOW.getTime() - 20 * 86_400_000),
    linkedAt: new Date(NOW.getTime() - 20 * 86_400_000),
    lastSeenAt: NOW,
    revokedAt: null,
  })));

  await db.insert(schema.cliSessions).values(installationIds.map((installationId, index) => ({
    id: randomUUID(),
    installationId,
    tokenPrefix: `qhcs${index}`,
    tokenDigest: randomBytes(32),
    userEmail: `admin-${index % 2}@${FIXTURE_EMAIL_DOMAIN}`,
    scopes: ["monitors:read"],
    createdAt: new Date(NOW.getTime() - 3_600_000),
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    lastUsedAt: NOW,
    revokedAt: null,
  })));

  await db.insert(schema.deviceAuthorizations).values([{
    id: randomUUID(),
    deviceCodeDigest: randomBytes(32),
    userCode: "QHFX-0001",
    scopeProfile: "cli-default",
    clientName: "qh-fixture-client",
    installationKey: "qh-fixture-install-pending",
    installationName: "qh-fixture-pending-device",
    platform: "darwin",
    architecture: "arm64",
    clientVersion: "0.0.0-fixture",
    requestIp: "198.51.100.7",
    state: "pending",
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 600_000),
    pollingIntervalSeconds: 5,
    lastPolledAt: null,
    pollCount: 0,
    approvedByEmail: null,
    approvedAt: null,
    deniedAt: null,
    consumedAt: null,
  }]);

  await db.insert(schema.apiIdempotency).values([{
    id: randomUUID(),
    principalKey: "qh-fixture",
    idempotencyKey: "qh-fixture-idem-key-1",
    method: "POST",
    routeKey: "/api/v1/config",
    requestHash: "qh-fixture-request-hash",
    responseStatus: 200,
    responseBody: { fixture: true },
    state: "completed",
    createdAt: new Date(NOW.getTime() - 60_000),
    completedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 86_400_000),
  }]);

  await db.insert(schema.apiRateLimitBuckets).values([{
    principalKey: "qh-fixture",
    routeKey: "/api/v1/config",
    resourceKey: "",
    windowStartedAt: new Date(NOW.getTime() - 30_000),
    windowSeconds: 60,
    requestCount: 3,
    expiresAt: new Date(NOW.getTime() + 30_000),
  }]);

  return { exceptionCount: exceptionRows.length, adminCount: adminIds.length };
}

const FIXTURE_MARKER_TABLE_SQL = `
create table if not exists "_query_perf_fixture" (
  "tag" text primary key,
  "version" integer not null,
  "seeded_at" timestamptz not null default now(),
  "cardinalities" jsonb not null
)
`;

// Deletes the fixture marker row so a reset/reseed that dies partway through
// can never be mistaken for a valid, fully-written fixture: both seedFixture
// and resetFixture call this before touching any fixture-owned table, and
// seedFixture only re-inserts the marker once every seed write below has
// succeeded.
export async function deleteFixtureMarker(conn: GatedConnection): Promise<void> {
  await conn.sql`delete from "_query_perf_fixture" where tag = ${"qh-fixture"}`;
}

export async function seedFixture(conn: GatedConnection): Promise<FixtureCardinalities> {
  await conn.sql.unsafe(FIXTURE_MARKER_TABLE_SQL);
  await deleteFixtureMarker(conn);
  await resetFixtureData(conn);

  const plan = buildMonitorPlan();
  await insertMonitors(conn, plan);
  const { incidentCount, outboxCount, checkCount } = await insertChecksIncidentsAndOutbox(conn, plan);
  const { metricRollupCount, dailyRollupCount } = await insertRollups(conn, plan);
  await insertConfigAndOperations(conn, plan);
  const { cronRunCount, checkBatchCount } = await insertMaintenanceAndScheduler(conn, plan);
  const { exceptionCount, adminCount } = await insertExceptionsAndAuth(conn, plan);

  const cardinalities: FixtureCardinalities = {
    monitor_registry: plan.length,
    monitor_state: plan.length,
    check_results: checkCount,
    metric_rollups: metricRollupCount,
    daily_rollups: dailyRollupCount,
    incidents: incidentCount,
    notification_outbox: outboxCount,
    monitoring_config_snapshots: 2,
    config_change_approvals: 1,
    config_operations: 10,
    cron_runs: cronRunCount,
    job_leases: 1,
    check_batches: checkBatchCount,
    atomic_minute_commits: checkBatchCount,
    exception_payloads: exceptionCount,
    monitor_exceptions: exceptionCount,
    database_usage_snapshots: 30,
    admin_users: adminCount,
    human_sessions: adminCount,
    onboarding_progress: 1,
    api_tokens: 3,
    cli_installations: 2,
    cli_sessions: 2,
    device_authorizations: 1,
    api_idempotency: 1,
    api_rate_limit_buckets: 1,
  };

  // conn.sql and conn.db share one underlying postgres.js client, and
  // drizzle() rewires that client's jsonb serializer to a passthrough (it
  // pre-stringifies jsonb values itself before binding params). That makes
  // conn.sql.json(...) -- which relies on the default JSON.stringify
  // serializer -- hand a raw object to the wire protocol and crash. Stringify
  // here and cast explicitly instead of relying on that serializer.
  await conn.sql`
    insert into "_query_perf_fixture" (tag, version, cardinalities)
    values (${"qh-fixture"}, ${FIXTURE_VERSION}, ${JSON.stringify(cardinalities)}::jsonb)
    on conflict (tag) do update set
      version = excluded.version, seeded_at = now(), cardinalities = excluded.cardinalities
  `;

  return cardinalities;
}

export async function resetFixture(conn: GatedConnection): Promise<void> {
  await conn.sql.unsafe(FIXTURE_MARKER_TABLE_SQL);
  await deleteFixtureMarker(conn);
  await resetFixtureData(conn);
}
