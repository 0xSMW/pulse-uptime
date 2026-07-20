import "server-only";

import { and, desc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";

import { monitoringConfigSchema } from "@/lib/config/schema";
import { db } from "@/lib/db/client";
import { incidents, monitorRegistry, monitoringConfigSnapshots, monitorState, notificationOutbox } from "@/lib/db/schema";
import { normalizeRecipient, testNotificationKey } from "@/lib/notifications/idempotency";
import { getPublicStatus } from "@/lib/reporting/queries/status";

import { decodeCursor, encodeCursor, type CursorValue } from "./pagination";

const recipientSchema = z.string().trim().email();

type NotificationStatus = "pending" | "sending" | "sent" | "failed" | "dead";
type NotificationRow = { incidentId: string | null; status: NotificationStatus };

function durationSeconds(openedAt: Date, resolvedAt: Date | null, now = new Date()): number {
  return Math.max(0, Math.floor(((resolvedAt ?? now).getTime() - openedAt.getTime()) / 1_000));
}

// First-run gate for the incident APIs. An incident opened before its monitor
// activated is a setup-phase failure, not real downtime, so joining
// monitor_state and requiring openedAt at or after activatedAt drops it from the
// feed and the per-incident fetch. A null activatedAt fails the comparison, so a
// never-activated monitor surfaces no incidents. A genuine ongoing incident is
// unaffected: the backfill sets activatedAt at or before its openedAt.
const activationGate = gte(incidents.openedAt, monitorState.activatedAt);

function notificationSummary(rows: NotificationRow[]) {
  const sentCount = rows.filter((row) => row.status === "sent").length;
  const state = rows.some((row) => row.status === "dead")
    ? "dead" as const
    : rows.some((row) => row.status !== "sent")
      ? "retrying" as const
      : sentCount > 0 ? "sent" as const : "none" as const;
  return { state, sentCount };
}

function incidentResponse(row: {
  id: string; monitorId: string; monitorName: string; openedAt: Date; resolvedAt: Date | null;
  openingErrorCode: string | null; openingStatusCode: number | null;
}, notifications: NotificationRow[]) {
  return {
    id: row.id,
    monitorId: row.monitorId,
    monitorName: row.monitorName,
    openedAt: row.openedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    durationSeconds: durationSeconds(row.openedAt, row.resolvedAt),
    openingFailure: row.openingStatusCode !== null ? `HTTP ${row.openingStatusCode}` : row.openingErrorCode ?? "Unknown failure",
    status: row.openingStatusCode?.toString() ?? null,
    notificationSummary: notificationSummary(notifications),
  };
}

export type OperationalService = ReturnType<typeof createOperationalService>;

/**
 * The factory keeps route handlers thin and gives tests a narrow, provider-free seam.
 * Notification tests are enqueued through the existing outbox and delivered by the
 * normal Resend worker, retaining its provider idempotency behavior.
 */
export function createOperationalService(dependencies: {
  database: typeof db;
  getStatus: () => Promise<unknown>;
} = { database: db, getStatus: getPublicStatus }) {
  const database = dependencies.database;

  return {
    async listIncidents(input: { cursor: CursorValue | null; limit: number }) {
      const cursorDate = input.cursor ? new Date(input.cursor.sort) : null;
      if (cursorDate && Number.isNaN(cursorDate.getTime())) throw new OperationalInputError("INVALID_CURSOR", "Cursor is invalid");
      const after = cursorDate && input.cursor
        ? or(
          lt(incidents.openedAt, cursorDate),
          and(eq(incidents.openedAt, cursorDate), lt(incidents.id, input.cursor.id)),
        )
        : undefined;
      const rows = await database.select({
        id: incidents.id, monitorId: incidents.monitorId, monitorName: monitorRegistry.name,
        openedAt: incidents.openedAt, resolvedAt: incidents.resolvedAt,
        openingErrorCode: incidents.openingErrorCode, openingStatusCode: incidents.openingStatusCode,
      }).from(incidents).innerJoin(monitorRegistry, eq(monitorRegistry.id, incidents.monitorId))
        .innerJoin(monitorState, eq(monitorState.monitorId, incidents.monitorId))
        .where(and(after, activationGate)).orderBy(desc(incidents.openedAt), desc(incidents.id)).limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      const notifications = page.length === 0 ? [] : await database.select({
        incidentId: notificationOutbox.incidentId, status: notificationOutbox.status,
      }).from(notificationOutbox).where(inArray(notificationOutbox.incidentId, page.map((row) => row.id))).limit(4_000);
      const last = page.at(-1);
      return {
        data: page.map((row) => incidentResponse(row, notifications.filter((item) => item.incidentId === row.id))),
        nextCursor: rows.length > input.limit && last ? encodeCursor({ sort: last.openedAt.toISOString(), id: last.id }) : null,
      };
    },

    async findIncident(id: string) {
      const [row] = await database.select({
        id: incidents.id, monitorId: incidents.monitorId, monitorName: monitorRegistry.name,
        openedAt: incidents.openedAt, resolvedAt: incidents.resolvedAt,
        openingErrorCode: incidents.openingErrorCode, openingStatusCode: incidents.openingStatusCode,
      }).from(incidents).innerJoin(monitorRegistry, eq(monitorRegistry.id, incidents.monitorId))
        .innerJoin(monitorState, eq(monitorState.monitorId, incidents.monitorId))
        .where(and(eq(incidents.id, id), activationGate)).limit(1);
      if (!row) return null;
      const notifications = await database.select({ incidentId: notificationOutbox.incidentId, status: notificationOutbox.status })
        .from(notificationOutbox).where(eq(notificationOutbox.incidentId, id)).limit(100);
      return incidentResponse(row, notifications);
    },

    getStatus: () => dependencies.getStatus(),

    async enqueueTestNotification(input: { recipient?: string; testId: string; installationName?: string | null }) {
      const [config, monitor] = await Promise.all([
        database.select({ configJson: monitoringConfigSnapshots.configJson }).from(monitoringConfigSnapshots)
          .where(eq(monitoringConfigSnapshots.status, "accepted")).orderBy(desc(monitoringConfigSnapshots.acceptedAt)).limit(1),
        database.select({ id: monitorRegistry.id }).from(monitorRegistry)
          .where(and(eq(monitorRegistry.enabled, true), isNull(monitorRegistry.archivedAt))).orderBy(monitorRegistry.id).limit(1),
      ]);
      const selected = input.recipient ?? (() => {
        const parsed = monitoringConfigSchema.safeParse(config[0]?.configJson);
        return parsed.success ? parsed.data.settings.defaultRecipients[0] : undefined;
      })();
      const parsedRecipient = recipientSchema.safeParse(selected);
      if (!parsedRecipient.success) throw new OperationalInputError("RECIPIENT_REQUIRED", "A configured recipient is required");
      if (!monitor[0]) throw new OperationalInputError("MONITOR_REQUIRED", "An active monitor is required");
      const recipient = normalizeRecipient(parsedRecipient.data);
      const id = crypto.randomUUID();
      const now = new Date();
      const inserted = await database.insert(notificationOutbox).values({
        id,
        incidentId: null,
        monitorId: monitor[0].id,
        eventType: "notification.test",
        recipient,
        idempotencyKey: testNotificationKey(input.testId, recipient),
        payload: { type: "notification.test", ...(input.installationName ? { installationName: input.installationName } : {}) },
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().returning({ id: notificationOutbox.id });
      const existing = inserted[0] ?? (await database.select({ id: notificationOutbox.id }).from(notificationOutbox)
        .where(eq(notificationOutbox.idempotencyKey, testNotificationKey(input.testId, recipient))).limit(1))[0];
      return { id: existing?.id ?? id, state: "accepted" as const };
    },
  };
}

export class OperationalInputError extends Error {
  constructor(readonly code: "INVALID_CURSOR" | "RECIPIENT_REQUIRED" | "MONITOR_REQUIRED", message: string) {
    super(message);
    this.name = "OperationalInputError";
  }
}

export function parseIncidentCursor(value: string | null): CursorValue | null {
  if (!value) return null;
  const cursor = decodeCursor(value);
  if (!cursor || Number.isNaN(new Date(cursor.sort).getTime())) throw new OperationalInputError("INVALID_CURSOR", "Cursor is invalid");
  return cursor;
}

export const operationalService = createOperationalService();
