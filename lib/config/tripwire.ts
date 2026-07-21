import { compareLexically } from "./canonical"
import type { DeclarativeConfig, MonitorConfig } from "./schema"

type DestructiveChangeReason =
  | { type: "all-active-monitors-removed"; previousActiveCount: number }
  | { type: "removed-monitor-count"; removedCount: number; threshold: 5 }
  | {
      type: "removed-monitor-percentage"
      removedCount: number
      previousActiveCount: number
      percentage: number
      threshold: 20
    }
  | { type: "active-group-removed"; group: string; previousActiveCount: number }

export interface DestructiveChangeEvaluation {
  required: boolean
  previousActiveCount: number
  candidateActiveCount: number
  removedActiveMonitorIds: string[]
  reasons: DestructiveChangeReason[]
}

function activeMonitors(config: DeclarativeConfig): MonitorConfig[] {
  return config.monitors.filter((monitor) => monitor.enabled)
}

export function evaluateDestructiveChange(
  previous: DeclarativeConfig,
  candidate: DeclarativeConfig
): DestructiveChangeEvaluation {
  const previousActive = activeMonitors(previous)
  const candidateActive = activeMonitors(candidate)
  const candidateActiveIds = new Set(
    candidateActive.map((monitor) => monitor.id)
  )
  const removed = previousActive.filter(
    (monitor) => !candidateActiveIds.has(monitor.id)
  )
  const removedCount = removed.length
  const percentage =
    previousActive.length === 0
      ? 0
      : (removedCount / previousActive.length) * 100
  const reasons: DestructiveChangeReason[] = []

  if (previousActive.length > 0 && candidateActive.length === 0) {
    reasons.push({
      type: "all-active-monitors-removed",
      previousActiveCount: previousActive.length,
    })
  }
  if (removedCount > 5) {
    reasons.push({ type: "removed-monitor-count", removedCount, threshold: 5 })
  }
  if (percentage > 20) {
    reasons.push({
      type: "removed-monitor-percentage",
      removedCount,
      previousActiveCount: previousActive.length,
      percentage,
      threshold: 20,
    })
  }

  const previousGroups = new Map<string, MonitorConfig[]>()
  for (const monitor of previousActive) {
    if (monitor.groupId === null) {
      continue
    }
    const group = previousGroups.get(monitor.groupId) ?? []
    group.push(monitor)
    previousGroups.set(monitor.groupId, group)
  }
  const candidateById = new Map(
    candidateActive.map((monitor) => [monitor.id, monitor])
  )
  for (const [group, monitors] of [...previousGroups].sort(([left], [right]) =>
    compareLexically(left, right)
  )) {
    if (
      monitors.length >= 2 &&
      monitors.every(
        (monitor) => candidateById.get(monitor.id)?.groupId !== group
      )
    ) {
      reasons.push({
        type: "active-group-removed",
        group,
        previousActiveCount: monitors.length,
      })
    }
  }

  return {
    required: reasons.length > 0,
    previousActiveCount: previousActive.length,
    candidateActiveCount: candidateActive.length,
    removedActiveMonitorIds: removed
      .map((monitor) => monitor.id)
      .sort(compareLexically),
    reasons,
  }
}

export interface DestructiveApproval {
  targetConfigHash: string
  action: "bulk_archive"
  expiresAt: Date | string
  consumedAt: Date | string | null
}

export function isValidDestructiveApproval(
  approval: DestructiveApproval | null | undefined,
  targetConfigHash: string,
  now: Date = new Date()
): boolean {
  if (
    approval?.action !== "bulk_archive" ||
    approval.targetConfigHash !== targetConfigHash ||
    approval.consumedAt !== null
  ) {
    return false
  }
  const expiresAt =
    approval.expiresAt instanceof Date
      ? approval.expiresAt
      : new Date(approval.expiresAt)
  return (
    Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > now.getTime()
  )
}
