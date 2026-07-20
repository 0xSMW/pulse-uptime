import { createHash } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "@/lib/db/client";
import { checkResults, incidents, monitorState, notificationOutbox } from "@/lib/db/schema";
import { incidentNotificationKey } from "@/lib/notifications/idempotency";
import type { NotificationPayload } from "@/lib/notifications/types";
import { formatDuration } from "@/lib/reporting/format";

import { transitionMonitor } from "./state-machine";
import type {
  MonitorStateSnapshot,
  ProcessCheckResult,
  ScheduledCheck,
  StateTransition,
} from "./types";

type IncidentInsert = typeof incidents.$inferInsert;
type OutboxInsert = typeof notificationOutbox.$inferInsert;

export type ProcessCheckTransaction = {
  insertCheck(check: ScheduledCheck): Promise<boolean>;
  lockMonitorState(monitorId: string): Promise<MonitorStateSnapshot | null>;
  insertIncident(incident: IncidentInsert): Promise<void>;
  updateIncidentProgress(
    incidentId: string,
    progress: { lastFailureAt?: Date; firstSuccessAt?: Date | null },
    now: Date,
  ): Promise<void>;
  resolveIncident(incidentId: string, firstSuccessAt: Date, now: Date): Promise<void>;
  insertOutbox(rows: OutboxInsert[]): Promise<void>;
  updateMonitorState(state: MonitorStateSnapshot): Promise<void>;
};

export type ProcessCheckStore = {
  transaction<T>(work: (transaction: ProcessCheckTransaction) => Promise<T>): Promise<T>;
};

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash("sha256").update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function notificationRows(
  check: ScheduledCheck,
  incidentId: string,
  event: "opened" | "resolved",
  openedAt: Date,
  resolvedAt?: Date,
): OutboxInsert[] {
  const eventType = `incident.${event}`;
  const payload: NotificationPayload = event === "opened"
    ? {
        type: "incident.opened",
        monitorName: check.monitorName,
        incidentId,
        startedAt: openedAt.toISOString(),
        cause: check.errorMessage
          ?? (check.statusCode ? `HTTP ${check.statusCode}` : check.errorCode ?? "Check failed"),
      }
    : {
        type: "incident.resolved",
        monitorName: check.monitorName,
        incidentId,
        recoveredAt: (resolvedAt ?? check.checkedAt).toISOString(),
        duration: formatDuration(Math.max(
          0,
          ((resolvedAt ?? check.checkedAt).getTime() - openedAt.getTime()) / 1_000,
        )),
      };
  return [...new Set(check.recipients.map((recipient) => recipient.trim().toLowerCase()))]
    .sort()
    .map((recipient) => {
      const idempotencyKey = incidentNotificationKey(incidentId, event, recipient);
      return {
        id: deterministicUuid(`outbox/${idempotencyKey}`),
        incidentId,
        monitorId: check.monitorId,
        eventType,
        recipient,
        idempotencyKey,
        payload,
        status: "pending" as const,
        attemptCount: 0,
        nextAttemptAt: check.checkedAt,
        createdAt: check.checkedAt,
        updatedAt: check.checkedAt,
      };
    });
}

async function applyTransition(
  tx: ProcessCheckTransaction,
  check: ScheduledCheck,
  transition: StateTransition,
): Promise<ProcessCheckResult> {
  let incidentId = transition.state.activeIncidentId;
  let event: "incident.opened" | "incident.resolved" | null = null;

  if (transition.incident?.type === "open") {
    incidentId = deterministicUuid(
      `incident/${check.monitorId}/${transition.incident.firstFailureAt.toISOString()}`,
    );
    await tx.insertIncident({
      id: incidentId,
      monitorId: check.monitorId,
      openedAt: transition.incident.openedAt,
      firstFailureAt: transition.incident.firstFailureAt,
      lastFailureAt: check.checkedAt,
      openingErrorCode: check.errorCode,
      openingStatusCode: check.statusCode,
      createdAt: check.checkedAt,
      updatedAt: check.checkedAt,
    });
    const rows = notificationRows(
      check,
      incidentId,
      "opened",
      transition.incident.openedAt,
    );
    if (rows.length > 0) await tx.insertOutbox(rows);
    transition.state.activeIncidentId = incidentId;
    event = "incident.opened";
  } else if (transition.incident?.type === "resolve") {
    incidentId = transition.incident.incidentId;
    await tx.resolveIncident(incidentId, transition.incident.firstSuccessAt, check.checkedAt);
    const rows = notificationRows(
      check,
      incidentId,
      "resolved",
      transition.incident.openedAt,
      transition.incident.resolvedAt,
    );
    if (rows.length > 0) await tx.insertOutbox(rows);
    event = "incident.resolved";
  } else if (incidentId && !check.successful &&
    (transition.previousState === "DOWN" || transition.previousState === "VERIFYING_UP")) {
    await tx.updateIncidentProgress(incidentId, {
      lastFailureAt: check.checkedAt,
      firstSuccessAt: null,
    }, check.checkedAt);
  } else if (incidentId && check.successful && transition.previousState === "DOWN" &&
    transition.state.state === "VERIFYING_UP") {
    await tx.updateIncidentProgress(incidentId, {
      firstSuccessAt: transition.state.firstSuccessAt,
    }, check.checkedAt);
  }

  await tx.updateMonitorState(transition.state);
  return {
    status: "processed",
    monitorId: check.monitorId,
    previousState: transition.previousState,
    state: transition.state.state,
    incidentId,
    event,
  };
}

export async function processCheckWithStore(
  store: ProcessCheckStore,
  check: ScheduledCheck,
): Promise<ProcessCheckResult> {
  return store.transaction(async (tx) => {
    if (!await tx.insertCheck(check)) {
      return { status: "duplicate", monitorId: check.monitorId, scheduledAt: check.scheduledAt };
    }

    const state = await tx.lockMonitorState(check.monitorId);
    if (!state) throw new Error(`Monitor state not found: ${check.monitorId}`);
    const transition = transitionMonitor(state, {
      type: "check",
      checkedAt: check.checkedAt,
      successful: check.successful,
      statusCode: check.statusCode,
      latencyMs: check.latencyMs,
      errorCode: check.errorCode,
      failureThreshold: check.failureThreshold,
      recoveryThreshold: check.recoveryThreshold,
    });
    return applyTransition(tx, check, transition);
  });
}

export function createDrizzleProcessCheckStore(database: Database): ProcessCheckStore {
  return {
    transaction: async <T>(work: (transaction: ProcessCheckTransaction) => Promise<T>) =>
      database.transaction(async (databaseTx) => work({
        async insertCheck(check) {
          const rows = await databaseTx.insert(checkResults).values({
            monitorId: check.monitorId,
            runId: check.runId,
            scheduledAt: check.scheduledAt,
            checkedAt: check.checkedAt,
            successful: check.successful,
            statusCode: check.statusCode,
            latencyMs: check.latencyMs,
            effectiveUrl: check.effectiveUrl,
            redirectCount: check.redirectCount,
            resolvedAddress: check.resolvedAddress,
            errorCode: check.errorCode,
            errorMessage: check.errorMessage,
            createdAt: check.checkedAt,
          }).onConflictDoNothing({
            target: [checkResults.monitorId, checkResults.scheduledAt],
          }).returning({ id: checkResults.id });
          return rows.length === 1;
        },
        async lockMonitorState(monitorId) {
          const rows = await databaseTx.select().from(monitorState)
            .where(eq(monitorState.monitorId, monitorId)).for("update");
          return rows[0] ?? null;
        },
        async insertIncident(incident) {
          await databaseTx.insert(incidents).values(incident);
        },
        async updateIncidentProgress(incidentId, progress, now) {
          const rows = await databaseTx.update(incidents).set({
            ...progress,
            updatedAt: now,
          }).where(and(eq(incidents.id, incidentId), isNull(incidents.resolvedAt)))
            .returning({ id: incidents.id });
          if (rows.length !== 1) throw new Error(`Active incident not found: ${incidentId}`);
        },
        async resolveIncident(incidentId, firstSuccessAt, now) {
          const rows = await databaseTx.update(incidents).set({
            firstSuccessAt,
            resolvedAt: firstSuccessAt,
            resolutionReason: "recovered",
            updatedAt: now,
          }).where(and(eq(incidents.id, incidentId), isNull(incidents.resolvedAt)))
            .returning({ id: incidents.id });
          if (rows.length !== 1) throw new Error(`Active incident not found: ${incidentId}`);
        },
        async insertOutbox(rows) {
          await databaseTx.insert(notificationOutbox).values(rows).onConflictDoNothing({
            target: notificationOutbox.idempotencyKey,
          });
        },
        async updateMonitorState(state) {
          const rows = await databaseTx.update(monitorState).set({
            state: state.state,
            consecutiveFailures: state.consecutiveFailures,
            consecutiveSuccesses: state.consecutiveSuccesses,
            activatedAt: state.activatedAt,
            firstFailureAt: state.firstFailureAt,
            firstSuccessAt: state.firstSuccessAt,
            lastCheckedAt: state.lastCheckedAt,
            lastSuccessAt: state.lastSuccessAt,
            lastFailureAt: state.lastFailureAt,
            lastStatusCode: state.lastStatusCode,
            lastLatencyMs: state.lastLatencyMs,
            lastErrorCode: state.lastErrorCode,
            activeIncidentId: state.activeIncidentId,
            version: state.version,
            updatedAt: state.updatedAt,
          }).where(eq(monitorState.monitorId, state.monitorId)).returning({ id: monitorState.monitorId });
          if (rows.length !== 1) throw new Error(`Monitor state not found: ${state.monitorId}`);
        },
      })),
  };
}

export function processCheck(database: Database, check: ScheduledCheck): Promise<ProcessCheckResult> {
  return processCheckWithStore(createDrizzleProcessCheckStore(database), check);
}
