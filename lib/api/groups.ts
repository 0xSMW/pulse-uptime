import "server-only"

import { z } from "zod"

import {
  type GroupConfig,
  groupConfigSchema,
  type MonitoringConfig,
} from "@/lib/config"
import { type DatabaseHandle, db } from "@/lib/db/client"

import {
  applyConfigChange,
  nextConfig,
  requireAcceptedConfig,
} from "./config-mutation"

const createGroupSchema = groupConfigSchema
const renameGroupSchema = z
  .object({ name: groupConfigSchema.shape.name })
  .strict()

export class GroupApiError extends Error {
  constructor(
    readonly code: "GROUP_NOT_FOUND" | "GROUP_EXISTS" | "GROUP_NOT_EMPTY",
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = "GroupApiError"
  }
}

function assertUniqueGroup(
  config: MonitoringConfig,
  candidate: GroupConfig,
  exceptId?: string
): void {
  if (
    config.groups.some(
      (group) => group.id === candidate.id && group.id !== exceptId
    )
  ) {
    throw new GroupApiError(
      "GROUP_EXISTS",
      "A group with this ID already exists"
    )
  }
  if (
    config.groups.some(
      (group) =>
        group.id !== exceptId &&
        group.name.toLocaleLowerCase("en-US") ===
          candidate.name.toLocaleLowerCase("en-US")
    )
  ) {
    throw new GroupApiError(
      "GROUP_EXISTS",
      "A group with this name already exists"
    )
  }
}

export function addGroup(
  config: MonitoringConfig,
  input: unknown
): MonitoringConfig {
  const group = createGroupSchema.parse(input)
  assertUniqueGroup(config, group)
  return nextConfig(config, { groups: [...config.groups, group] })
}

export function renameGroup(
  config: MonitoringConfig,
  id: string,
  input: unknown
): MonitoringConfig {
  const current = config.groups.find((candidate) => candidate.id === id)
  if (!current) {
    throw new GroupApiError("GROUP_NOT_FOUND", "Group was not found")
  }
  const group = { ...current, ...renameGroupSchema.parse(input) }
  assertUniqueGroup(config, group, id)
  if (group.name === current.name) {
    return config
  }
  return nextConfig(config, {
    groups: config.groups.map((item) => (item.id === id ? group : item)),
  })
}

export function removeGroup(
  config: MonitoringConfig,
  id: string
): MonitoringConfig {
  if (!config.groups.some((group) => group.id === id)) {
    throw new GroupApiError("GROUP_NOT_FOUND", "Group was not found")
  }
  const count = config.monitors.filter(
    (monitor) => monitor.groupId === id
  ).length
  if (count > 0) {
    throw new GroupApiError(
      "GROUP_NOT_EMPTY",
      "Move or ungroup monitors before deleting this group",
      { monitorCount: count }
    )
  }
  return nextConfig(config, {
    groups: config.groups.filter((group) => group.id !== id),
  })
}

function withCounts(config: MonitoringConfig) {
  return config.groups.map((group) => ({
    ...group,
    monitorCount: config.monitors.filter(
      (monitor) => monitor.groupId === group.id
    ).length,
  }))
}

export async function listGroups() {
  return withCounts((await requireAcceptedConfig()).config)
}

export async function createGroup(
  input: unknown,
  principalKey: string,
  handle: DatabaseHandle = db
) {
  const group = createGroupSchema.parse(input)
  const result = await applyConfigChange(
    principalKey,
    (config) => addGroup(config, group),
    handle
  )
  return {
    ...result.groups.find((item) => item.id === group.id)!,
    monitorCount: 0,
  }
}

export async function updateGroup(
  id: string,
  input: unknown,
  principalKey: string,
  handle: DatabaseHandle = db
) {
  const result = await applyConfigChange(
    principalKey,
    (config) => renameGroup(config, id, input),
    handle
  )
  return withCounts(result).find((group) => group.id === id)!
}

export async function deleteGroup(
  id: string,
  principalKey: string,
  handle: DatabaseHandle = db
) {
  await applyConfigChange(
    principalKey,
    (config) => removeGroup(config, id),
    handle
  )
  return { id, deleted: true }
}
