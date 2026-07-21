import type { CheckErrorCode } from "@/lib/checker/types"
import type { monitorStates } from "@/lib/db/schema"

export type MonitorState = (typeof monitorStates)[number]

export type VisibleMonitorState = Exclude<MonitorState, "ARCHIVED">

export const MONITOR_STATE_ORDER = [
  "DOWN",
  "VERIFYING_DOWN",
  "VERIFYING_UP",
  "PENDING",
  "UP",
  "PAUSED",
  "ARCHIVED",
] as const satisfies readonly MonitorState[]

export interface TimelineBucket {
  state: "up" | "down" | "verifying" | "paused" | "no-data"
  label: string
  checks: number
  failures: number
  downtimeSeconds?: number
  // Epoch millis of the bucket's covered range. Carried so the timeline
  // tooltip can render a human date and time range in the viewer's zone
  // without reparsing the ISO label. Optional because label-only call sites
  // (the dependency timeline) still build buckets without them.
  startMs?: number
  endMs?: number
}

export interface HealthWarning {
  code: string
  message: string
  action: string
}

export interface MonitorStateSnapshot {
  monitorId: string
  state: MonitorState
  consecutiveFailures: number
  consecutiveSuccesses: number
  activatedAt: Date | null
  firstFailureAt: Date | null
  firstSuccessAt: Date | null
  lastCheckedAt: Date | null
  lastSuccessAt: Date | null
  lastFailureAt: Date | null
  lastStatusCode: number | null
  lastLatencyMs: number | null
  lastErrorCode: string | null
  activeIncidentId: string | null
  version: number
  updatedAt: Date
}

export interface CheckTransitionEvent {
  type: "check"
  checkedAt: Date
  successful: boolean
  statusCode: number | null
  latencyMs: number
  errorCode: CheckErrorCode | null
  failureThreshold: number
  recoveryThreshold: number
}

interface LifecycleTransitionEvent {
  type: "disable" | "archive" | "enable" | "restore"
  occurredAt: Date
}

export type MonitorTransitionEvent =
  | CheckTransitionEvent
  | LifecycleTransitionEvent

export type IncidentIntent =
  | { type: "open"; openedAt: Date; firstFailureAt: Date }
  | {
      type: "resolve"
      incidentId: string
      openedAt: Date
      resolvedAt: Date
      firstSuccessAt: Date
    }
  | null

export interface StateTransition {
  previousState: MonitorState
  state: MonitorStateSnapshot
  changed: boolean
  incident: IncidentIntent
}

export interface ScheduledCheck {
  monitorId: string
  monitorName: string
  runId: string
  scheduledAt: Date
  checkedAt: Date
  successful: boolean
  statusCode: number | null
  latencyMs: number
  effectiveUrl: string | null
  redirectCount: number
  resolvedAddress: string | null
  errorCode: CheckErrorCode | null
  errorMessage: string | null
  failureThreshold: number
  recoveryThreshold: number
  recipients: string[]
}
