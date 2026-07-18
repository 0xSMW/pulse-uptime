import "server-only";

import { z } from "zod";

import { groupConfigSchema, type GroupConfig, type MonitoringConfig } from "@/lib/config";

import { loadAcceptedConfig, mutateConfig, nextConfig } from "./config-mutation";

const createGroupSchema = groupConfigSchema;
const renameGroupSchema = z.object({ name: groupConfigSchema.shape.name }).strict();

export class GroupApiError extends Error {
  constructor(readonly code: "GROUP_NOT_FOUND" | "GROUP_EXISTS" | "GROUP_NOT_EMPTY", message: string, readonly details?: Record<string, unknown>) {
    super(message); this.name = "GroupApiError";
  }
}

function assertUniqueGroup(config: MonitoringConfig, candidate: GroupConfig, exceptId?: string): void {
  if (config.groups.some((group) => group.id === candidate.id && group.id !== exceptId)) throw new GroupApiError("GROUP_EXISTS", "A group with this ID already exists");
  if (config.groups.some((group) => group.id !== exceptId && group.name.toLocaleLowerCase("en-US") === candidate.name.toLocaleLowerCase("en-US"))) {
    throw new GroupApiError("GROUP_EXISTS", "A group with this name already exists");
  }
}

export function addGroup(config: MonitoringConfig, input: unknown): MonitoringConfig {
  const group = createGroupSchema.parse(input);
  assertUniqueGroup(config, group);
  return nextConfig(config, { groups: [...config.groups, group] });
}

export function renameGroup(config: MonitoringConfig, id: string, input: unknown): MonitoringConfig {
  const current = config.groups.find((group) => group.id === id);
  if (!current) throw new GroupApiError("GROUP_NOT_FOUND", "Group was not found");
  const group = { ...current, ...renameGroupSchema.parse(input) };
  assertUniqueGroup(config, group, id);
  if (group.name === current.name) return config;
  return nextConfig(config, { groups: config.groups.map((item) => item.id === id ? group : item) });
}

export function removeGroup(config: MonitoringConfig, id: string): MonitoringConfig {
  if (!config.groups.some((group) => group.id === id)) throw new GroupApiError("GROUP_NOT_FOUND", "Group was not found");
  const count = config.monitors.filter((monitor) => monitor.groupId === id).length;
  if (count > 0) throw new GroupApiError("GROUP_NOT_EMPTY", "Move or ungroup monitors before deleting this group", { monitorCount: count });
  return nextConfig(config, { groups: config.groups.filter((group) => group.id !== id) });
}

function withCounts(config: MonitoringConfig) {
  return config.groups.map((group) => ({ ...group, monitorCount: config.monitors.filter((monitor) => monitor.groupId === group.id).length }));
}

export async function listGroups() { return withCounts((await loadAcceptedConfig()).config); }

export async function createGroup(input: unknown, principalKey: string) {
  const group = createGroupSchema.parse(input);
  const result = await mutateConfig(principalKey, (config) => addGroup(config, group));
  return { ...result.groups.find((item) => item.id === group.id)!, monitorCount: 0 };
}

export async function recoverCreatedGroup(input: unknown) {
  const desired = createGroupSchema.parse(input); const config = (await loadAcceptedConfig()).config;
  const group = config.groups.find((item) => item.id === desired.id);
  return group?.name === desired.name ? { ...group, monitorCount: config.monitors.filter((monitor) => monitor.groupId === group.id).length } : null;
}

export async function updateGroup(id: string, input: unknown, principalKey: string) {
  const result = await mutateConfig(principalKey, (config) => renameGroup(config, id, input));
  return withCounts(result).find((group) => group.id === id)!;
}

export async function recoverUpdatedGroup(id: string, input: unknown) {
  const desired = renameGroupSchema.parse(input); const config = (await loadAcceptedConfig()).config;
  const group = config.groups.find((item) => item.id === id);
  return group?.name === desired.name ? { ...group, monitorCount: config.monitors.filter((monitor) => monitor.groupId === id).length } : null;
}

export async function recoverDeletedGroup(id: string) {
  const config = (await loadAcceptedConfig()).config;
  return config.groups.some((group) => group.id === id) ? null : { id, deleted: true };
}

export async function deleteGroup(id: string, principalKey: string) {
  await mutateConfig(principalKey, (config) => removeGroup(config, id));
  return { id, deleted: true };
}
