export type IncidentFilter = "all" | "ongoing" | "resolved"

type NotificationState = "sent" | "retrying" | "dead" | "none"

export interface IncidentSummary {
  id: string
  monitorId: string
  monitorName: string
  openedAt: string
  resolvedAt: string | null
  durationSeconds: number
  openingFailure: string
  notificationSummary: {
    state: NotificationState
    sentCount: number
  }
}

export type IncidentEventType =
  | "first_failure"
  | "failure_confirmed"
  | "outage_queued"
  | "outage_sent"
  | "first_success"
  | "recovery_confirmed"
  | "recovery_queued"
  | "recovery_sent"

export interface IncidentEvent {
  type: IncidentEventType
  at: string
}

/**
 * Neutral timing context from an installed dependency's provider incident,
 * per Docs/DEPENDENCY-MONITORING.md "Incident correlation". Timing and
 * source only, never a causal claim.
 */
export interface DependencyIncidentOverlap {
  dependencyId: string
  dependencyName: string
  provider: string
  incidentId: string
  incidentTitle: string
  providerStartedAt: string
  providerResolvedAt: string | null
  canonicalUrl: string | null
  matchKind: string
  offsetSeconds: number
}

export interface IncidentDetail extends IncidentSummary {
  events: IncidentEvent[]
  overlaps: DependencyIncidentOverlap[]
}
