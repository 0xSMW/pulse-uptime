import "server-only"

import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm"
import { z } from "zod"

import { findAcceptedSnapshot } from "@/lib/config/accepted-config"
import { db } from "@/lib/db/client"
import {
  incidents,
  monitorRegistry,
  monitorState,
  notificationOutbox,
} from "@/lib/db/schema"
import {
  activationGate,
  durationSeconds,
  failureLabel,
  type NotificationDeliveryStatus,
  summarizeNotificationRows,
} from "@/lib/monitoring/incident-shape"
import {
  normalizeRecipient,
  testNotificationKey,
} from "@/lib/notifications/idempotency"
import { getPublicStatus } from "@/lib/reporting/queries/status"

import {
  decodeTimestampUuidCursor,
  encodeCursor,
  type TimestampUuidCursor,
} from "./pagination"

const recipientSchema = z.string().trim().email()

interface NotificationRow {
  incidentId: string | null
  status: NotificationDeliveryStatus
}

function incidentResponse(
  row: {
    id: string
    monitorId: string
    monitorName: string
    openedAt: Date
    resolvedAt: Date | null
    openingErrorCode: string | null
    openingStatusCode: number | null
  },
  notifications: NotificationRow[]
) {
  return {
    id: row.id,
    monitorId: row.monitorId,
    monitorName: row.monitorName,
    openedAt: row.openedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    durationSeconds: durationSeconds(row.openedAt, row.resolvedAt),
    openingFailure: failureLabel(row.openingErrorCode, row.openingStatusCode),
    openingStatusCode: row.openingStatusCode,
    notificationSummary: summarizeNotificationRows(notifications),
  }
}

export type OperationalService = ReturnType<typeof createOperationalService>

/**
 * The factory keeps route handlers thin and gives tests a narrow, provider-free seam.
 * Notification tests are enqueued through the existing outbox and delivered by the
 * normal Resend worker, retaining its provider idempotency behavior.
 */
export function createOperationalService(
  dependencies: { database: typeof db; getStatus: () => Promise<unknown> } = {
    database: db,
    getStatus: getPublicStatus,
  }
) {
  const database = dependencies.database

  return {
    async listIncidents(input: {
      cursor: TimestampUuidCursor | null
      limit: number
    }) {
      // Cursor is already Date+UUID-validated by parseIncidentCursor.
      const after = input.cursor
        ? or(
            lt(incidents.openedAt, input.cursor.sort),
            and(
              eq(incidents.openedAt, input.cursor.sort),
              lt(incidents.id, input.cursor.id)
            )
          )
        : undefined
      const rows = await database
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
        .innerJoin(
          monitorState,
          eq(monitorState.monitorId, incidents.monitorId)
        )
        .where(and(after, activationGate))
        .orderBy(desc(incidents.openedAt), desc(incidents.id))
        .limit(input.limit + 1)
      const page = rows.slice(0, input.limit)
      const notifications =
        page.length === 0
          ? []
          : await database
              .select({
                incidentId: notificationOutbox.incidentId,
                status: notificationOutbox.status,
              })
              .from(notificationOutbox)
              .where(
                inArray(
                  notificationOutbox.incidentId,
                  page.map((row) => row.id)
                )
              )
              .limit(4000)
      const last = page.at(-1)
      return {
        data: page.map((row) =>
          incidentResponse(
            row,
            notifications.filter((item) => item.incidentId === row.id)
          )
        ),
        nextCursor:
          rows.length > input.limit && last
            ? encodeCursor({ sort: last.openedAt.toISOString(), id: last.id })
            : null,
      }
    },

    async findIncident(id: string) {
      const [row] = await database
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
        .innerJoin(
          monitorState,
          eq(monitorState.monitorId, incidents.monitorId)
        )
        .where(and(eq(incidents.id, id), activationGate))
        .limit(1)
      if (!row) {
        return null
      }
      const notifications = await database
        .select({
          incidentId: notificationOutbox.incidentId,
          status: notificationOutbox.status,
        })
        .from(notificationOutbox)
        .where(eq(notificationOutbox.incidentId, id))
        .limit(100)
      return incidentResponse(row, notifications)
    },

    getStatus: () => dependencies.getStatus(),

    async enqueueTestNotification(input: {
      recipient?: string
      testId: string
      installationName?: string | null
    }) {
      const monitorQuery = database
        .select({ id: monitorRegistry.id })
        .from(monitorRegistry)
        .where(
          and(
            eq(monitorRegistry.enabled, true),
            isNull(monitorRegistry.archivedAt)
          )
        )
        .orderBy(monitorRegistry.id)
        .limit(1)
      // The accepted config is only consulted to supply a default recipient. An
      // explicit recipient never touches it, and a corrupt or hash-mismatched
      // snapshot yields no default rather than a raw 500, leaving the absent
      // recipient to surface as RECIPIENT_REQUIRED.
      let selected = input.recipient
      if (selected == null) {
        let snapshot: Awaited<ReturnType<typeof findAcceptedSnapshot>> = null
        try {
          snapshot = await findAcceptedSnapshot(database)
        } catch {
          snapshot = null
        }
        selected = snapshot?.config.settings.defaultRecipients[0]
      }
      const monitor = await monitorQuery
      const parsedRecipient = recipientSchema.safeParse(selected)
      if (!parsedRecipient.success) {
        throw new OperationalInputError(
          "RECIPIENT_REQUIRED",
          "A configured recipient is required"
        )
      }
      if (!monitor[0]) {
        throw new OperationalInputError(
          "MONITOR_REQUIRED",
          "An active monitor is required"
        )
      }
      const recipient = normalizeRecipient(parsedRecipient.data)
      const id = crypto.randomUUID()
      const now = new Date()
      const inserted = await database
        .insert(notificationOutbox)
        .values({
          id,
          incidentId: null,
          monitorId: monitor[0].id,
          eventType: "notification.test",
          recipient,
          idempotencyKey: testNotificationKey(input.testId, recipient),
          payload: {
            type: "notification.test",
            ...(input.installationName
              ? { installationName: input.installationName }
              : {}),
          },
          status: "pending",
          attemptCount: 0,
          nextAttemptAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: notificationOutbox.id })
      const existing =
        inserted[0] ??
        (
          await database
            .select({ id: notificationOutbox.id })
            .from(notificationOutbox)
            .where(
              eq(
                notificationOutbox.idempotencyKey,
                testNotificationKey(input.testId, recipient)
              )
            )
            .limit(1)
        )[0]
      return { id: existing?.id ?? id, state: "accepted" as const }
    },
  }
}

export class OperationalInputError extends Error {
  constructor(
    readonly code: "INVALID_CURSOR" | "RECIPIENT_REQUIRED" | "MONITOR_REQUIRED",
    message: string
  ) {
    super(message)
    this.name = "OperationalInputError"
  }
}

export function parseIncidentCursor(
  value: string | null
): TimestampUuidCursor | null {
  const decoded = decodeTimestampUuidCursor(value)
  if (!decoded.ok) {
    throw new OperationalInputError("INVALID_CURSOR", "Cursor is invalid")
  }
  return decoded.cursor
}

export const operationalService = createOperationalService()
