import { desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { incidents, monitorRegistry, notificationOutbox } from "@/lib/db/schema";

export type IncidentFilter = "all" | "ongoing" | "resolved";

export async function hasConfiguredMonitors(): Promise<boolean> {
  const [monitor] = await db.select({ id: monitorRegistry.id })
    .from(monitorRegistry)
    .where(isNull(monitorRegistry.archivedAt))
    .limit(1);
  return Boolean(monitor);
}

type NotificationRow = {
  incidentId: string | null;
  status: "pending" | "sending" | "sent" | "failed" | "dead";
};

function durationSeconds(openedAt: Date, resolvedAt: Date | null, now = new Date()): number {
  return Math.max(0, Math.floor(((resolvedAt ?? now).getTime() - openedAt.getTime()) / 1_000));
}

function failureLabel(errorCode: string | null, statusCode: number | null): string {
  if (statusCode !== null) return `HTTP ${statusCode}`;
  return errorCode ?? "Unknown failure";
}

function summarizeNotifications(rows: NotificationRow[]) {
  const sentCount = rows.filter((row) => row.status === "sent").length;
  const state = rows.some((row) => row.status === "dead")
    ? "dead" as const
    : rows.some((row) => row.status !== "sent")
      ? "retrying" as const
      : sentCount > 0
        ? "sent" as const
        : "none" as const;
  return { state, sentCount };
}

export async function listIncidents(filter: IncidentFilter = "all") {
  const condition = filter === "ongoing"
    ? isNull(incidents.resolvedAt)
    : filter === "resolved"
      ? isNotNull(incidents.resolvedAt)
      : undefined;
  const rows = await db.select({
    id: incidents.id,
    monitorId: incidents.monitorId,
    monitorName: monitorRegistry.name,
    openedAt: incidents.openedAt,
    resolvedAt: incidents.resolvedAt,
    openingErrorCode: incidents.openingErrorCode,
    openingStatusCode: incidents.openingStatusCode,
  }).from(incidents)
    .innerJoin(monitorRegistry, eq(monitorRegistry.id, incidents.monitorId))
    .where(condition)
    .orderBy(desc(incidents.openedAt))
    .limit(100);

  const notifications = rows.length === 0 ? [] : await db.select({
    incidentId: notificationOutbox.incidentId,
    status: notificationOutbox.status,
  }).from(notificationOutbox)
    .where(inArray(notificationOutbox.incidentId, rows.map((row) => row.id)))
    .limit(4_000);

  return rows.map((row) => {
    const related = notifications.filter((notification) => notification.incidentId === row.id);
    return {
      id: row.id,
      monitorId: row.monitorId,
      monitorName: row.monitorName,
      openedAt: row.openedAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      durationSeconds: durationSeconds(row.openedAt, row.resolvedAt),
      openingFailure: failureLabel(row.openingErrorCode, row.openingStatusCode),
      status: row.openingStatusCode?.toString() ?? null,
      notificationSummary: summarizeNotifications(related),
    };
  });
}

export async function getIncidentDetail(id: string) {
  const [row] = await db.select({
    id: incidents.id,
    monitorId: incidents.monitorId,
    monitorName: monitorRegistry.name,
    openedAt: incidents.openedAt,
    firstFailureAt: incidents.firstFailureAt,
    firstSuccessAt: incidents.firstSuccessAt,
    resolvedAt: incidents.resolvedAt,
    openingErrorCode: incidents.openingErrorCode,
    openingStatusCode: incidents.openingStatusCode,
  }).from(incidents)
    .innerJoin(monitorRegistry, eq(monitorRegistry.id, incidents.monitorId))
    .where(eq(incidents.id, id))
    .limit(1);
  if (!row) return null;

  const notifications = await db.select({
    eventType: notificationOutbox.eventType,
    status: notificationOutbox.status,
    createdAt: notificationOutbox.createdAt,
    sentAt: notificationOutbox.sentAt,
  }).from(notificationOutbox)
    .where(eq(notificationOutbox.incidentId, id))
    .orderBy(notificationOutbox.createdAt)
    .limit(40);
  const outage = notifications.filter((notification) => notification.eventType === "incident.opened");
  const recovery = notifications.filter((notification) => notification.eventType === "incident.resolved");
  const firstSent = (rows: typeof notifications) => rows.find((notification) => notification.sentAt)?.sentAt;
  const events = [
    { type: "first_failure" as const, at: row.firstFailureAt },
    { type: "failure_confirmed" as const, at: row.openedAt },
    outage[0] ? { type: "outage_queued" as const, at: outage[0].createdAt } : null,
    firstSent(outage) ? { type: "outage_sent" as const, at: firstSent(outage)! } : null,
    row.firstSuccessAt ? { type: "first_success" as const, at: row.firstSuccessAt } : null,
    row.resolvedAt ? { type: "recovery_confirmed" as const, at: row.resolvedAt } : null,
    recovery[0] ? { type: "recovery_queued" as const, at: recovery[0].createdAt } : null,
    firstSent(recovery) ? { type: "recovery_sent" as const, at: firstSent(recovery)! } : null,
  ].filter((event): event is NonNullable<typeof event> => event !== null)
    .map((event) => ({ type: event.type, at: event.at.toISOString() }));

  return {
    id: row.id,
    monitorId: row.monitorId,
    monitorName: row.monitorName,
    openedAt: row.openedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    durationSeconds: durationSeconds(row.openedAt, row.resolvedAt),
    openingFailure: failureLabel(row.openingErrorCode, row.openingStatusCode),
    status: row.openingStatusCode?.toString() ?? null,
    notificationSummary: summarizeNotifications(notifications.map((notification) => ({ incidentId: id, status: notification.status }))),
    events,
  };
}
