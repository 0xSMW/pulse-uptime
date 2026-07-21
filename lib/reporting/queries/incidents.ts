import {
  and,
  desc,
  sql as dsql,
  eq,
  inArray,
  isNotNull,
  isNull,
} from "drizzle-orm"

import { db } from "@/lib/db/client"
import {
  incidents,
  monitorRegistry,
  monitorState,
  notificationOutbox,
} from "@/lib/db/schema"
import { listOverlappingDependencyIncidents } from "@/lib/dependencies/overlap"
import {
  activationGate,
  durationSeconds,
  failureLabel,
  summarizeNotificationAggregate,
  summarizeNotificationRows,
} from "@/lib/monitoring/incident-shape"

// Re-exported so existing callers and tests keep importing it from this module.
export { summarizeNotificationAggregate }

export type IncidentFilter = "all" | "ongoing" | "resolved"

export async function hasConfiguredMonitors(): Promise<boolean> {
  const [monitor] = await db
    .select({ id: monitorRegistry.id })
    .from(monitorRegistry)
    .where(isNull(monitorRegistry.archivedAt))
    .limit(1)
  return Boolean(monitor)
}

// Slim projection for the command palette: no notification data, so the
// dashboard layout never drags the outbox into its critical path.
export async function listCommandPaletteIncidents() {
  const rows = await db
    .select({
      id: incidents.id,
      monitorId: incidents.monitorId,
      monitorName: monitorRegistry.name,
      openedAt: incidents.openedAt,
      openingErrorCode: incidents.openingErrorCode,
      openingStatusCode: incidents.openingStatusCode,
    })
    .from(incidents)
    .innerJoin(monitorRegistry, eq(monitorRegistry.id, incidents.monitorId))
    .innerJoin(monitorState, eq(monitorState.monitorId, incidents.monitorId))
    .where(and(isNull(incidents.resolvedAt), activationGate))
    .orderBy(desc(incidents.openedAt))
    .limit(100)

  return rows.map((row) => ({
    id: row.id,
    monitorId: row.monitorId,
    monitorName: row.monitorName,
    openedAt: row.openedAt.toISOString(),
    openingFailure: failureLabel(row.openingErrorCode, row.openingStatusCode),
  }))
}

export async function listIncidents(filter: IncidentFilter = "all") {
  const condition =
    filter === "ongoing"
      ? isNull(incidents.resolvedAt)
      : filter === "resolved"
        ? isNotNull(incidents.resolvedAt)
        : undefined
  const rows = await db
    .select({
      id: incidents.id,
      monitorId: incidents.monitorId,
      monitorName: monitorRegistry.name,
      openedAt: incidents.openedAt,
      resolvedAt: incidents.resolvedAt,
      openingErrorCode: incidents.openingErrorCode,
      openingStatusCode: incidents.openingStatusCode,
    })
    .from(incidents)
    .innerJoin(monitorRegistry, eq(monitorRegistry.id, incidents.monitorId))
    .innerJoin(monitorState, eq(monitorState.monitorId, incidents.monitorId))
    .where(and(condition, activationGate))
    .orderBy(desc(incidents.openedAt))
    .limit(100)

  // Aggregated in SQL: one row per incident, so the result stays bounded
  // regardless of outbox size.
  const summaries =
    rows.length === 0
      ? []
      : await db
          .select({
            incidentId: notificationOutbox.incidentId,
            sentCount:
              dsql<number>`count(*) filter (where ${notificationOutbox.status} = 'sent')`.mapWith(
                Number
              ),
            anyDead: dsql<boolean>`bool_or(${notificationOutbox.status} = 'dead')`,
            anyUnsent: dsql<boolean>`bool_or(${notificationOutbox.status} <> 'sent')`,
          })
          .from(notificationOutbox)
          .where(
            inArray(
              notificationOutbox.incidentId,
              rows.map((row) => row.id)
            )
          )
          .groupBy(notificationOutbox.incidentId)
  const summaryByIncident = new Map(
    summaries.map((summary) => [summary.incidentId, summary])
  )

  return rows.map((row) => {
    const summary = summaryByIncident.get(row.id)
    return {
      id: row.id,
      monitorId: row.monitorId,
      monitorName: row.monitorName,
      openedAt: row.openedAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      durationSeconds: durationSeconds(row.openedAt, row.resolvedAt),
      openingFailure: failureLabel(row.openingErrorCode, row.openingStatusCode),
      notificationSummary: summarizeNotificationAggregate(
        summary ?? { sentCount: 0, anyDead: false, anyUnsent: false }
      ),
    }
  })
}

export async function findIncidentDetail(id: string) {
  const [row] = await db
    .select({
      id: incidents.id,
      monitorId: incidents.monitorId,
      monitorName: monitorRegistry.name,
      openedAt: incidents.openedAt,
      firstFailureAt: incidents.firstFailureAt,
      firstSuccessAt: incidents.firstSuccessAt,
      resolvedAt: incidents.resolvedAt,
      openingErrorCode: incidents.openingErrorCode,
      openingStatusCode: incidents.openingStatusCode,
    })
    .from(incidents)
    .innerJoin(monitorRegistry, eq(monitorRegistry.id, incidents.monitorId))
    .innerJoin(monitorState, eq(monitorState.monitorId, incidents.monitorId))
    .where(and(eq(incidents.id, id), activationGate))
    .limit(1)
  if (!row) {
    return null
  }

  const notifications = await db
    .select({
      eventType: notificationOutbox.eventType,
      status: notificationOutbox.status,
      createdAt: notificationOutbox.createdAt,
      sentAt: notificationOutbox.sentAt,
    })
    .from(notificationOutbox)
    .where(eq(notificationOutbox.incidentId, id))
    .orderBy(notificationOutbox.createdAt)
    .limit(40)
  const outage = notifications.filter(
    (notification) => notification.eventType === "incident.opened"
  )
  const recovery = notifications.filter(
    (notification) => notification.eventType === "incident.resolved"
  )
  const firstSent = (rows: typeof notifications) =>
    rows.find((notification) => notification.sentAt)?.sentAt
  const events = [
    { type: "first_failure" as const, at: row.firstFailureAt },
    { type: "failure_confirmed" as const, at: row.openedAt },
    outage[0]
      ? { type: "outage_queued" as const, at: outage[0].createdAt }
      : null,
    firstSent(outage)
      ? { type: "outage_sent" as const, at: firstSent(outage)! }
      : null,
    row.firstSuccessAt
      ? { type: "first_success" as const, at: row.firstSuccessAt }
      : null,
    row.resolvedAt
      ? { type: "recovery_confirmed" as const, at: row.resolvedAt }
      : null,
    recovery[0]
      ? { type: "recovery_queued" as const, at: recovery[0].createdAt }
      : null,
    firstSent(recovery)
      ? { type: "recovery_sent" as const, at: firstSent(recovery)! }
      : null,
  ]
    .filter((event): event is NonNullable<typeof event> => event !== null)
    .map((event) => ({ type: event.type, at: event.at.toISOString() }))

  // Neutral timing context only: never a causal claim. See
  // Docs/Specs/DEPENDENCY-MONITORING.md "Incident correlation".
  const overlaps = await listOverlappingDependencyIncidents({
    openedAt: row.openedAt,
    resolvedAt: row.resolvedAt,
  })

  return {
    id: row.id,
    monitorId: row.monitorId,
    monitorName: row.monitorName,
    openedAt: row.openedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    durationSeconds: durationSeconds(row.openedAt, row.resolvedAt),
    openingFailure: failureLabel(row.openingErrorCode, row.openingStatusCode),
    notificationSummary: summarizeNotificationRows(notifications),
    events,
    overlaps,
  }
}
