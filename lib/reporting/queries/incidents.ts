import {
  and,
  desc,
  sql as dsql,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
} from "drizzle-orm"
import {
  decodeTimestampUuidCursor,
  encodeCursor,
  type TimestampUuidCursor,
} from "@/lib/api/pagination"
import { db } from "@/lib/db/client"
import {
  incidents,
  monitorRegistry,
  monitorState,
  notificationOutbox,
  statusReports,
} from "@/lib/db/schema"
import { listOverlappingDependencyIncidents } from "@/lib/dependencies/overlap"
import { loadIncidentExclusionStatuses } from "@/lib/incidents/exclusions"
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

// The monitor name for the incidents page filter context. Archived monitors
// still resolve because their incidents stay listed.
export async function findIncidentMonitorName(
  monitorId: string
): Promise<string | null> {
  const [monitor] = await db
    .select({ name: monitorRegistry.name })
    .from(monitorRegistry)
    .where(eq(monitorRegistry.id, monitorId))
    .limit(1)
  return monitor?.name ?? null
}

export const INCIDENT_PAGE_SIZE = 100

// A missing or malformed cursor reads as the first page, so a stale or edited
// link never errors.
export function parseIncidentListCursor(
  value: string | null | undefined
): TimestampUuidCursor | null {
  const decoded = decodeTimestampUuidCursor(value ?? null)
  return decoded.ok ? decoded.cursor : null
}

// Status, monitor, and cursor filters for the incidents list. A null monitor
// id lists every monitor. The cursor continues after the last row of the
// previous page in (opened_at desc, id desc) order. The id tiebreak keeps
// incidents opened at the same instant in one stable order, so no row repeats
// or drops between pages.
export function incidentListCondition(
  filter: IncidentFilter,
  monitorId: string | null = null,
  cursor: TimestampUuidCursor | null = null
) {
  const status =
    filter === "ongoing"
      ? isNull(incidents.resolvedAt)
      : filter === "resolved"
        ? isNotNull(incidents.resolvedAt)
        : undefined
  const after = cursor
    ? or(
        lt(incidents.openedAt, cursor.sort),
        and(eq(incidents.openedAt, cursor.sort), lt(incidents.id, cursor.id))
      )
    : undefined
  return and(
    status,
    monitorId === null ? undefined : eq(incidents.monitorId, monitorId),
    after
  )
}

// Splits a limit+1 fetch into the visible page and the cursor for the next
// one. The cursor is null when nothing older remains.
export function incidentPage<Row extends { id: string; openedAt: Date }>(
  rows: Row[],
  limit: number
): { page: Row[]; nextCursor: string | null } {
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    page,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ sort: last.openedAt.toISOString(), id: last.id })
        : null,
  }
}

export async function listIncidents({
  filter = "all",
  monitorId = null,
  cursor = null,
  limit = INCIDENT_PAGE_SIZE,
}: {
  filter?: IncidentFilter
  monitorId?: string | null
  cursor?: TimestampUuidCursor | null
  limit?: number
} = {}) {
  const condition = incidentListCondition(filter, monitorId, cursor)
  const fetched = await db
    .select({
      id: incidents.id,
      monitorId: incidents.monitorId,
      monitorName: monitorRegistry.name,
      openedAt: incidents.openedAt,
      resolvedAt: incidents.resolvedAt,
      openingErrorCode: incidents.openingErrorCode,
      openingStatusCode: incidents.openingStatusCode,
      // At most one report per incident (partial unique index on
      // origin_incident_id), so the join never duplicates a row.
      reportId: statusReports.id,
    })
    .from(incidents)
    .innerJoin(monitorRegistry, eq(monitorRegistry.id, incidents.monitorId))
    .innerJoin(monitorState, eq(monitorState.monitorId, incidents.monitorId))
    .leftJoin(statusReports, eq(statusReports.originIncidentId, incidents.id))
    .where(and(condition, activationGate))
    .orderBy(desc(incidents.openedAt), desc(incidents.id))
    .limit(limit + 1)
  const { page: rows, nextCursor } = incidentPage(fetched, limit)

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

  const exclusions = await loadIncidentExclusionStatuses(
    rows.map((row) => row.id)
  )
  const data = rows.map((row) => {
    const summary = summaryByIncident.get(row.id)
    return {
      id: row.id,
      monitorId: row.monitorId,
      monitorName: row.monitorName,
      openedAt: row.openedAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      durationSeconds: durationSeconds(row.openedAt, row.resolvedAt),
      openingFailure: failureLabel(row.openingErrorCode, row.openingStatusCode),
      exclusionStatus: exclusions.get(row.id) ?? null,
      reportId: row.reportId,
      notificationSummary: summarizeNotificationAggregate(
        summary ?? { sentCount: 0, anyDead: false, anyUnsent: false }
      ),
    }
  })
  return { data, nextCursor }
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
      // Same unique report join as the list, so the page can link to it.
      reportId: statusReports.id,
    })
    .from(incidents)
    .innerJoin(monitorRegistry, eq(monitorRegistry.id, incidents.monitorId))
    .innerJoin(monitorState, eq(monitorState.monitorId, incidents.monitorId))
    .leftJoin(statusReports, eq(statusReports.originIncidentId, incidents.id))
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

  const exclusions = await loadIncidentExclusionStatuses([row.id])
  return {
    exclusionStatus: exclusions.get(row.id) ?? null,
    firstFailureAt: row.firstFailureAt.toISOString(),
    id: row.id,
    monitorId: row.monitorId,
    monitorName: row.monitorName,
    openedAt: row.openedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    durationSeconds: durationSeconds(row.openedAt, row.resolvedAt),
    openingFailure: failureLabel(row.openingErrorCode, row.openingStatusCode),
    reportId: row.reportId,
    notificationSummary: summarizeNotificationRows(notifications),
    events,
    overlaps,
  }
}
