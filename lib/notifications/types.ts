import { z } from "zod"

export type NotificationEventType =
  | "incident.opened"
  | "incident.resolved"
  | "notification.test"
  | "dependency.incident"
  | "dependency.recovery"
  | "system.alert"

/** Ordinary outbox rows claimed by monitor-check and dependency crons. system.alert is owned by the sweep drain only. */
export const ORDINARY_NOTIFICATION_EVENT_TYPES = [
  "incident.opened",
  "incident.resolved",
  "notification.test",
  "dependency.incident",
  "dependency.recovery",
] as const satisfies readonly NotificationEventType[]

const nonempty = z.string().trim().min(1)

export const incidentOpenedPayloadSchema = z.object({
  type: z.literal("incident.opened"),
  monitorName: nonempty,
  incidentId: nonempty,
  startedAt: nonempty,
  cause: nonempty,
})

export const incidentResolvedPayloadSchema = z.object({
  type: z.literal("incident.resolved"),
  monitorName: nonempty,
  incidentId: nonempty,
  recoveredAt: nonempty,
  duration: nonempty,
})

export const testNotificationPayloadSchema = z.object({
  type: z.literal("notification.test"),
  installationName: nonempty.optional(),
})

// Provider-reported dependency incidents/recoveries. Carries everything the
// email needs to render (name, provider, title, state, link, provider
// timestamp) so delivery never has to join back to dependency tables.
export const dependencyIncidentPayloadSchema = z.object({
  type: z.literal("dependency.incident"),
  dependencyName: nonempty,
  provider: nonempty,
  incidentTitle: nonempty,
  state: nonempty,
  canonicalUrl: z.string().url().nullable(),
  providerTimestamp: nonempty,
})

export const dependencyRecoveryPayloadSchema = z.object({
  type: z.literal("dependency.recovery"),
  dependencyName: nonempty,
  provider: nonempty,
  incidentTitle: nonempty,
  state: nonempty,
  canonicalUrl: z.string().url().nullable(),
  providerTimestamp: nonempty,
})

// Operator-facing self-alert with no monitor or dependency subject. Raised when
// the monitoring loop itself is broken (stale or failing), so it carries the
// human title, the detail body, the machine reason, and when it was detected.
export const systemAlertPayloadSchema = z.object({
  type: z.literal("system.alert"),
  title: nonempty,
  detail: nonempty,
  reason: nonempty,
  detectedAt: nonempty,
})

export const notificationPayloadSchema = z.discriminatedUnion("type", [
  incidentOpenedPayloadSchema,
  incidentResolvedPayloadSchema,
  testNotificationPayloadSchema,
  dependencyIncidentPayloadSchema,
  dependencyRecoveryPayloadSchema,
  systemAlertPayloadSchema,
])

export type IncidentOpenedPayload = z.infer<typeof incidentOpenedPayloadSchema>

export type IncidentResolvedPayload = z.infer<
  typeof incidentResolvedPayloadSchema
>

export type TestNotificationPayload = z.infer<
  typeof testNotificationPayloadSchema
>

export type DependencyIncidentPayload = z.infer<
  typeof dependencyIncidentPayloadSchema
>

export type DependencyRecoveryPayload = z.infer<
  typeof dependencyRecoveryPayloadSchema
>

export type SystemAlertPayload = z.infer<typeof systemAlertPayloadSchema>

export type NotificationPayload =
  | IncidentOpenedPayload
  | IncidentResolvedPayload
  | TestNotificationPayload
  | DependencyIncidentPayload
  | DependencyRecoveryPayload
  | SystemAlertPayload

export interface ClaimedNotification {
  id: string
  incidentId: string | null
  monitorId: string | null
  dependencyId: string | null
  eventType: NotificationEventType
  recipient: string
  idempotencyKey: string
  payload: NotificationPayload
  attemptCount: number
  claimToken: string
}

export interface DeliveryLogEntry {
  event: "notification.sent" | "notification.failed"
  notificationId: string
  incidentId?: string
  monitorId?: string
  dependencyId?: string
  attemptCount: number
  errorCode?: string
}

export type NotificationLogger = (entry: DeliveryLogEntry) => void
