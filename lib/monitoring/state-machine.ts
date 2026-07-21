import type {
  CheckTransitionEvent,
  IncidentIntent,
  MonitorStateSnapshot,
  MonitorTransitionEvent,
  StateTransition,
} from "./types"

const CHECK_STATES = new Set([
  "PENDING",
  "UP",
  "VERIFYING_DOWN",
  "DOWN",
  "VERIFYING_UP",
])

function validateThreshold(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`)
  }
}

function checkedState(
  current: MonitorStateSnapshot,
  event: CheckTransitionEvent
): {
  next: MonitorStateSnapshot
  incident: IncidentIntent
} {
  validateThreshold(event.failureThreshold, "failureThreshold")
  validateThreshold(event.recoveryThreshold, "recoveryThreshold")

  if (!CHECK_STATES.has(current.state)) {
    return { next: current, incident: null }
  }

  const next: MonitorStateSnapshot = {
    ...current,
    lastCheckedAt: event.checkedAt,
    lastStatusCode: event.statusCode,
    lastLatencyMs: event.latencyMs,
    updatedAt: event.checkedAt,
    version: current.version + 1,
  }

  if (event.successful) {
    next.lastSuccessAt = event.checkedAt
    next.lastErrorCode = null
    next.consecutiveFailures = 0
    // The first ever success activates the monitor and ends the setup phase.
    if (current.activatedAt === null) {
      next.activatedAt = event.checkedAt
    }

    if (
      current.state === "PENDING" ||
      current.state === "UP" ||
      current.state === "VERIFYING_DOWN"
    ) {
      next.state = "UP"
      next.firstFailureAt = null
      next.consecutiveSuccesses = 0
      next.firstSuccessAt = null
      return { next, incident: null }
    }

    const firstSuccessAt =
      current.state === "VERIFYING_UP" && current.firstSuccessAt
        ? current.firstSuccessAt
        : event.checkedAt
    const successes =
      current.state === "VERIFYING_UP" ? current.consecutiveSuccesses + 1 : 1
    next.firstSuccessAt = firstSuccessAt
    next.consecutiveSuccesses = successes
    next.firstFailureAt = current.firstFailureAt

    if (successes < event.recoveryThreshold) {
      next.state = "VERIFYING_UP"
      return { next, incident: null }
    }
    if (!current.activeIncidentId) {
      throw new Error("Cannot resolve DOWN monitor without an active incident")
    }
    if (!current.firstFailureAt) {
      throw new Error(
        "Cannot resolve DOWN monitor without a first failure time"
      )
    }
    next.state = "UP"
    next.consecutiveSuccesses = 0
    next.firstSuccessAt = null
    next.firstFailureAt = null
    next.activeIncidentId = null
    return {
      next,
      incident: {
        type: "resolve",
        incidentId: current.activeIncidentId,
        openedAt: current.firstFailureAt,
        resolvedAt: firstSuccessAt,
        firstSuccessAt,
      },
    }
  }

  next.lastFailureAt = event.checkedAt
  next.lastErrorCode = event.errorCode
  next.consecutiveSuccesses = 0
  next.firstSuccessAt = null

  if (current.state === "DOWN" || current.state === "VERIFYING_UP") {
    next.state = "DOWN"
    next.consecutiveFailures = Math.max(
      current.consecutiveFailures,
      event.failureThreshold
    )
    next.firstFailureAt = current.firstFailureAt
    return { next, incident: null }
  }

  const firstFailureAt =
    (current.state === "VERIFYING_DOWN" || current.state === "PENDING") &&
    current.firstFailureAt
      ? current.firstFailureAt
      : event.checkedAt
  const failures =
    current.state === "VERIFYING_DOWN" || current.state === "PENDING"
      ? current.consecutiveFailures + 1
      : 1
  next.firstFailureAt = firstFailureAt
  next.consecutiveFailures = failures

  if (failures < event.failureThreshold) {
    next.state = current.state === "PENDING" ? "PENDING" : "VERIFYING_DOWN"
    return { next, incident: null }
  }
  // A monitor that has never succeeded stays in the setup phase no matter how
  // many times it fails. Setup failures never open incidents or mark downtime,
  // so the monitor holds PENDING until its first success activates it. Only a
  // never-activated PENDING monitor qualifies, since any activated monitor has
  // left PENDING for good.
  if (current.state === "PENDING" && current.activatedAt === null) {
    next.state = "PENDING"
    return { next, incident: null }
  }
  next.state = "DOWN"
  return {
    next,
    incident: { type: "open", openedAt: firstFailureAt, firstFailureAt },
  }
}

export function transitionMonitor(
  current: MonitorStateSnapshot,
  event: MonitorTransitionEvent
): StateTransition {
  if (event.type === "check") {
    const { next, incident } = checkedState(current, event)
    return {
      previousState: current.state,
      state: next,
      changed: next !== current && next.state !== current.state,
      incident,
    }
  }

  let state = current.state
  if (event.type === "disable" && CHECK_STATES.has(current.state)) {
    state = "PAUSED"
  }
  if (event.type === "archive" && current.state !== "ARCHIVED") {
    state = "ARCHIVED"
  }
  if (event.type === "enable" && current.state === "PAUSED") {
    state = "PENDING"
  }
  if (event.type === "restore" && current.state === "ARCHIVED") {
    state = "PENDING"
  }

  if (state === current.state) {
    return {
      previousState: current.state,
      state: current,
      changed: false,
      incident: null,
    }
  }
  return {
    previousState: current.state,
    state: {
      ...current,
      state,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      firstFailureAt: null,
      firstSuccessAt: null,
      version: current.version + 1,
      updatedAt: event.occurredAt,
    },
    changed: true,
    incident: null,
  }
}
