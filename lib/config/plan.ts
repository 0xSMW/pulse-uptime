import { hashCanonical, hashDeclarativeConfig } from "./canonical"
import type {
  DeclarativeConfig,
  GroupConfig,
  MonitorConfig,
  MonitoringSettings,
} from "./schema"
import {
  type DestructiveChangeEvaluation,
  evaluateDestructiveChange,
} from "./tripwire"
import { validateDeclarativeConfig } from "./validation"

interface SettingChange {
  path: string
  before: unknown
  after: unknown
}

interface MonitorUpdate {
  id: string
  before: MonitorConfig | null
  after: MonitorConfig
  changedFields: string[]
  restore?: true
}

export interface ConfigurationDiff {
  settingsChanged: SettingChange[]
  groupCreates: GroupConfig[]
  groupUpdates: Array<{
    id: string
    before: GroupConfig
    after: GroupConfig
    changedFields: string[]
  }>
  groupDeletes: GroupConfig[]
  creates: MonitorConfig[]
  updates: MonitorUpdate[]
  pauses: MonitorConfig[]
  resumes: MonitorConfig[]
  archives: MonitorConfig[]
  unchanged: MonitorConfig[]
}

export interface ConfigurationPlan {
  baseConfigHash: string
  targetConfigHash: string
  planHash: string
  targetConfig: DeclarativeConfig
  diff: ConfigurationDiff
  destructiveApprovalRequired: boolean
  destructiveChange: DestructiveChangeEvaluation
  // Authoritative allowDelete requirement. Archiving any monitor or any
  // tripwire-flagged destructive change both demand explicit allowDelete.
  allowDeleteRequired: boolean
}

export interface PlanOptions {
  baseConfigHash?: string
  /** Registry entries omitted from accepted config because they were archived. */
  archivedMonitors?: readonly MonitorConfig[]
}

function diffSettings(
  before: MonitoringSettings,
  after: MonitoringSettings
): SettingChange[] {
  const changes: SettingChange[] = []
  const walk = (left: unknown, right: unknown, path: string): void => {
    if (hashCanonical(left) === hashCanonical(right)) {
      return
    }
    if (
      left !== null &&
      right !== null &&
      typeof left === "object" &&
      typeof right === "object" &&
      !Array.isArray(left) &&
      !Array.isArray(right)
    ) {
      const keys = [
        ...new Set([...Object.keys(left), ...Object.keys(right)]),
      ].sort()
      for (const key of keys) {
        walk(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
          path ? `${path}.${key}` : key
        )
      }
      return
    }
    changes.push({ path, before: left, after: right })
  }
  walk(before, after, "settings")
  return changes
}

function changedMonitorFields(
  before: MonitorConfig,
  after: MonitorConfig
): string[] {
  return Object.keys(after)
    .filter(
      (key) =>
        key !== "id" &&
        hashCanonical(before[key as keyof MonitorConfig]) !==
          hashCanonical(after[key as keyof MonitorConfig])
    )
    .sort()
    .map((key) => `monitors.${after.id}.${key}`)
}

export function calculateConfigurationDiff(
  current: DeclarativeConfig,
  target: DeclarativeConfig,
  archivedMonitors: readonly MonitorConfig[] = []
): ConfigurationDiff {
  const currentById = new Map(
    current.monitors.map((monitor) => [monitor.id, monitor])
  )
  const targetById = new Map(
    target.monitors.map((monitor) => [monitor.id, monitor])
  )
  const archivedById = new Map(
    archivedMonitors.map((monitor) => [monitor.id, monitor])
  )
  const diff: ConfigurationDiff = {
    settingsChanged: diffSettings(current.settings, target.settings),
    groupCreates: [],
    groupUpdates: [],
    groupDeletes: [],
    creates: [],
    updates: [],
    pauses: [],
    resumes: [],
    archives: [],
    unchanged: [],
  }
  const currentGroups = new Map(
    current.groups.map((group) => [group.id, group])
  )
  const targetGroups = new Map(target.groups.map((group) => [group.id, group]))
  for (const group of target.groups) {
    const before = currentGroups.get(group.id)
    if (!before) {
      diff.groupCreates.push(group)
    } else if (hashCanonical(before) !== hashCanonical(group)) {
      diff.groupUpdates.push({
        id: group.id,
        before,
        after: group,
        changedFields: [`groups.${group.id}.name`],
      })
    }
  }
  for (const group of current.groups) {
    if (!targetGroups.has(group.id)) {
      diff.groupDeletes.push(group)
    }
  }

  for (const monitor of target.monitors) {
    const before = currentById.get(monitor.id)
    if (!before) {
      const archived = archivedById.get(monitor.id)
      if (archived) {
        diff.updates.push({
          id: monitor.id,
          before: archived,
          after: monitor,
          changedFields: changedMonitorFields(archived, monitor),
          restore: true,
        })
        if (monitor.enabled) {
          diff.resumes.push(monitor)
        }
      } else {
        diff.creates.push(monitor)
      }
      continue
    }

    const changedFields = changedMonitorFields(before, monitor)
    const nonStateChanges = changedFields.filter(
      (path) => !path.endsWith(".enabled")
    )
    if (nonStateChanges.length > 0) {
      diff.updates.push({
        id: monitor.id,
        before,
        after: monitor,
        changedFields: nonStateChanges,
      })
    }
    if (before.enabled && !monitor.enabled) {
      diff.pauses.push(monitor)
    }
    if (!before.enabled && monitor.enabled) {
      diff.resumes.push(monitor)
    }
    if (changedFields.length === 0) {
      diff.unchanged.push(monitor)
    }
  }

  for (const monitor of current.monitors) {
    if (!targetById.has(monitor.id)) {
      diff.archives.push(monitor)
    }
  }

  return diff
}

export function createConfigurationPlan(
  currentInput: unknown,
  targetInput: unknown,
  options: PlanOptions = {}
): ConfigurationPlan {
  const current = validateDeclarativeConfig(currentInput)
  const targetConfig = validateDeclarativeConfig(targetInput)
  const baseConfigHash =
    options.baseConfigHash ?? hashDeclarativeConfig(current)
  const targetConfigHash = hashDeclarativeConfig(targetConfig)
  const diff = calculateConfigurationDiff(
    current,
    targetConfig,
    options.archivedMonitors
  )
  const destructiveChange = evaluateDestructiveChange(current, targetConfig)
  const planHash = hashCanonical({ baseConfigHash, targetConfigHash, diff })
  return {
    baseConfigHash,
    targetConfigHash,
    planHash,
    targetConfig,
    diff,
    destructiveApprovalRequired: destructiveChange.required,
    destructiveChange,
    allowDeleteRequired: diff.archives.length > 0 || destructiveChange.required,
  }
}
