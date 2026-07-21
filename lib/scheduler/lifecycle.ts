import { transitionMonitor } from "@/lib/monitoring/state-machine"
import type {
  MonitorStateName,
  MonitorStateSnapshot,
} from "@/lib/monitoring/types"

export type LifecycleTarget = "ACTIVE" | "PAUSED" | "ARCHIVED"

export interface LifecycleMutation {
  changed: boolean
  state: MonitorStateSnapshot
  resolution: null | {
    incidentId: string
    resolvedAt: Date
    reason:
      | "monitor_paused"
      | "monitor_archived"
      | "monitor_enabled"
      | "monitor_restored"
  }
}

function apply(
  current: MonitorStateSnapshot,
  type: "disable" | "archive" | "enable" | "restore",
  at: Date
) {
  return transitionMonitor(current, { type, occurredAt: at }).state
}

export function transitionLifecycle(
  current: MonitorStateSnapshot,
  target: LifecycleTarget,
  occurredAt: Date
): LifecycleMutation {
  let state = current
  if (target === "ARCHIVED") {
    state = apply(state, "archive", occurredAt)
  }
  if (target === "PAUSED") {
    if (state.state === "ARCHIVED") {
      state = apply(state, "restore", occurredAt)
    }
    state = apply(state, "disable", occurredAt)
  }
  if (target === "ACTIVE") {
    if (state.state === "ARCHIVED") {
      state = apply(state, "restore", occurredAt)
    } else if (state.state === "PAUSED") {
      state = apply(state, "enable", occurredAt)
    }
  }
  let changed = state.version !== current.version
  const needsCleanup =
    current.activeIncidentId !== null ||
    current.consecutiveFailures !== 0 ||
    current.consecutiveSuccesses !== 0 ||
    current.firstFailureAt !== null ||
    current.firstSuccessAt !== null
  if (!changed && target !== "ACTIVE" && needsCleanup) {
    changed = true
    state = { ...state, version: current.version + 1, updatedAt: occurredAt }
  }
  const resolution =
    changed && current.activeIncidentId
      ? {
          incidentId: current.activeIncidentId,
          resolvedAt: occurredAt,
          reason:
            target === "PAUSED"
              ? ("monitor_paused" as const)
              : target === "ARCHIVED"
                ? ("monitor_archived" as const)
                : current.state === "ARCHIVED"
                  ? ("monitor_restored" as const)
                  : ("monitor_enabled" as const),
        }
      : null
  if (changed) {
    state = {
      ...state,
      activeIncidentId: null,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      firstFailureAt: null,
      firstSuccessAt: null,
    }
  }
  return { changed, state, resolution }
}

export function targetFor(
  enabled: boolean,
  archived: boolean
): LifecycleTarget {
  if (archived) {
    return "ARCHIVED"
  }
  return enabled ? "ACTIVE" : "PAUSED"
}

export function isLifecycleState(value: string): value is MonitorStateName {
  return [
    "PENDING",
    "UP",
    "VERIFYING_DOWN",
    "DOWN",
    "VERIFYING_UP",
    "PAUSED",
    "ARCHIVED",
  ].includes(value)
}
