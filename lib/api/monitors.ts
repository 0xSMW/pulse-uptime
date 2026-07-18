import "server-only";
import { createHash } from "node:crypto";

import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { z } from "zod";

import { runManualCheck } from "@/lib/checker";
import {
  createMonitorWithDefaults,
  hashCanonical,
  monitorConfigSchema,
  type GroupConfig,
  type MonitorConfig,
} from "@/lib/config";
import { db } from "@/lib/db/client";
import {
  monitorRegistry,
  monitorState,
} from "@/lib/db/schema";

import { ConfigMutationError, loadAcceptedConfig as loadConfigSnapshot, mutateConfig as mutateConfiguration, nextConfig } from "./config-mutation";
import { decodeCursor, encodeCursor } from "./pagination";

const idSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).min(3).max(64);
const createSchemaBase = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(80),
  url: z.string(),
  enabled: z.boolean().optional(),
  group: z.string().trim().min(1).max(50).nullable().optional(),
  groupId: idSchema.nullable().optional(),
  method: z.enum(["GET", "HEAD"]).optional(),
  intervalMinutes: z.union([z.literal(1), z.literal(5), z.literal(10), z.literal(15)]).optional(),
  timeoutMs: z.number().int().min(1_000).max(15_000).optional(),
  expectedStatus: z.object({ minimum: z.number().int(), maximum: z.number().int() }).strict().optional(),
  failureThreshold: z.number().int().min(1).max(5).optional(),
  recoveryThreshold: z.number().int().min(1).max(5).optional(),
  recipients: z.array(z.string()).max(20).optional(),
}).strict();
const exclusiveGroup = (value: { group?: unknown; groupId?: unknown }) => !(value.group !== undefined && value.groupId !== undefined);
const createSchema = createSchemaBase.refine(exclusiveGroup, { message: "Use either group or groupId", path: ["groupId"] });

const patchSchema = createSchemaBase.omit({ id: true }).partial().refine(exclusiveGroup, { message: "Use either group or groupId", path: ["groupId"] }).refine((value) => Object.keys(value).length > 0, {
  message: "At least one monitor field is required",
});

export class MonitorApiError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "MONITOR_NOT_FOUND" | "MONITOR_EXISTS" | "CONFIGURATION_UNAVAILABLE" | "EDGE_CONFIG_UNAVAILABLE", message: string) {
    super(message);
    this.name = "MonitorApiError";
  }
}

function translateConfigError(error: unknown): never {
  if (error instanceof ConfigMutationError) throw new MonitorApiError(error.code, error.message);
  throw error;
}

async function loadAcceptedConfig() {
  try { return await loadConfigSnapshot(); } catch (error) { return translateConfigError(error); }
}

async function mutateConfig(...args: Parameters<typeof mutateConfiguration>) {
  try { return await mutateConfiguration(...args); } catch (error) { return translateConfigError(error); }
}

function resolveGroupId(value: { group?: string | null; groupId?: string | null }, groups: readonly GroupConfig[]): string | null {
  if (value.groupId !== undefined) return value.groupId;
  if (value.group === undefined || value.group === null) return null;
  return groups.find((group) => group.name.toLocaleLowerCase("en-US") === value.group!.trim().toLocaleLowerCase("en-US"))?.id ?? null;
}

export function parseCreateMonitor(input: unknown, groups: readonly GroupConfig[] = []): MonitorConfig {
  const value = createSchema.parse(input);
  const fields = { ...value };
  delete fields.group;
  return monitorConfigSchema.parse({ ...createMonitorWithDefaults(fields), ...fields, groupId: resolveGroupId(value, groups) });
}

export function parsePatchMonitor(input: unknown): z.infer<typeof patchSchema> {
  return patchSchema.parse(input);
}

export function mergeMonitorPatch(monitor: MonitorConfig, patch: z.infer<typeof patchSchema>): MonitorConfig {
  const fields = { ...patch };
  delete fields.group;
  return monitorConfigSchema.parse({ ...monitor, ...fields, expectedStatus: patch.expectedStatus ?? monitor.expectedStatus });
}

function groupsForLegacyInput(groups: readonly GroupConfig[], input: unknown): GroupConfig[] {
  const parsed = createSchemaBase.partial().safeParse(input);
  const name = parsed.success ? parsed.data.group : undefined;
  if (name === undefined || name === null || groups.some((group) => group.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"))) return [...groups];
  return [...groups, { id: `group-${createHash("sha256").update(name.toLocaleLowerCase("en-US")).digest("hex").slice(0, 12)}`, name }];
}

function monitorResponse(monitor: MonitorConfig, groups: readonly GroupConfig[]) {
  return { ...monitor, group: monitor.groupId ? groups.find((group) => group.id === monitor.groupId)?.name ?? null : null };
}

export async function createMonitor(input: unknown, principalKey: string) {
  let created!: MonitorConfig;
  const result = await mutateConfig(principalKey, (current) => {
    const groups = groupsForLegacyInput(current.groups, input);
    const monitor = parseCreateMonitor(input, groups);
    created = monitor;
    const existing = current.monitors.find((item) => item.id === monitor.id);
    if (existing) {
      if (hashCanonical(existing) === hashCanonical(monitor)) return current;
      throw new MonitorApiError("MONITOR_EXISTS", "A monitor with this ID already exists");
    }
    return nextConfig(current, { groups, monitors: [...current.monitors, monitor] });
  });
  return monitorResponse(result.monitors.find((item) => item.id === created.id)!, result.groups);
}

export async function recoverCreatedMonitor(input: unknown) {
  const current = await loadAcceptedConfig();
  const groups = groupsForLegacyInput(current.config.groups, input);
  const desired = parseCreateMonitor(input, groups);
  const existing = current.config.monitors.find((monitor) => monitor.id === desired.id);
  return existing && hashCanonical(existing) === hashCanonical(desired) ? monitorResponse(existing, current.config.groups) : null;
}

export async function updateMonitor(id: string, input: unknown, principalKey: string) {
  const patch = parsePatchMonitor(input);
  const result = await mutateConfig(principalKey, (current) => {
    const existing = current.monitors.find((item) => item.id === id);
    if (!existing) throw new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found");
    const groups = groupsForLegacyInput(current.groups, input);
    const nextPatch = patch.group !== undefined || patch.groupId !== undefined
      ? { ...patch, groupId: resolveGroupId(patch, groups) }
      : patch;
    return nextConfig(current, { groups, monitors: current.monitors.map((item) => item.id === id ? mergeMonitorPatch(item, nextPatch) : item) });
  });
  return monitorResponse(result.monitors.find((item) => item.id === id)!, result.groups);
}

export async function recoverUpdatedMonitor(id: string, input: unknown) {
  const patch = parsePatchMonitor(input);
  const current = await loadAcceptedConfig();
  const existing = current.config.monitors.find((monitor) => monitor.id === id);
  if (!existing) return null;
  const groups = groupsForLegacyInput(current.config.groups, input);
  const nextPatch = patch.group !== undefined || patch.groupId !== undefined
    ? { ...patch, groupId: resolveGroupId(patch, groups) }
    : patch;
  return hashCanonical(mergeMonitorPatch(existing, nextPatch)) === hashCanonical(existing) ? monitorResponse(existing, current.config.groups) : null;
}

export async function deleteMonitor(id: string, principalKey: string) {
  try {
    await mutateConfig(principalKey, (current) => {
      if (!current.monitors.some((item) => item.id === id)) throw new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found");
      return nextConfig(current, { monitors: current.monitors.filter((item) => item.id !== id) });
    });
  } catch (error) {
    if (!(error instanceof MonitorApiError) || error.code !== "MONITOR_NOT_FOUND") throw error;
    const [archived] = await db.select({ id: monitorRegistry.id }).from(monitorRegistry)
      .where(and(eq(monitorRegistry.id, id), drizzleSql`${monitorRegistry.archivedAt} is not null`)).limit(1);
    if (!archived) throw error;
  }
  return { id, deleted: true };
}

export async function recoverDeletedMonitor(id: string) {
  const [archived] = await db.select({ id: monitorRegistry.id }).from(monitorRegistry)
    .where(and(eq(monitorRegistry.id, id), drizzleSql`${monitorRegistry.archivedAt} is not null`)).limit(1);
  return archived ? { id, deleted: true } : null;
}

export async function setMonitorEnabled(id: string, enabled: boolean, principalKey: string) {
  const result = await mutateConfig(principalKey, (current) => {
    if (!current.monitors.some((item) => item.id === id)) throw new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found");
    return nextConfig(current, { monitors: current.monitors.map((item) => item.id === id ? { ...item, enabled } : item) });
  });
  return monitorResponse(result.monitors.find((item) => item.id === id)!, result.groups);
}

export async function recoverMonitorEnabled(id: string, enabled: boolean) {
  const current = await loadAcceptedConfig();
  const monitor = current.config.monitors.find((item) => item.id === id);
  return monitor?.enabled === enabled ? monitorResponse(monitor, current.config.groups) : null;
}

export async function getMonitor(id: string) {
  const accepted = await loadAcceptedConfig();
  const monitor = accepted.config.monitors.find((item) => item.id === id);
  if (!monitor) throw new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found");
  return monitorResponse(monitor, accepted.config.groups);
}

const STATE_ORDER = ["DOWN", "VERIFYING_DOWN", "VERIFYING_UP", "PENDING", "UP", "PAUSED", "ARCHIVED"] as const;
type MonitorStateValue = (typeof STATE_ORDER)[number];

export async function listMonitors(options: {
  cursor: string | null;
  limit: number;
  state?: MonitorStateValue;
  group?: string;
  groupId?: string;
  enabled?: boolean;
  sort?: "state" | "name" | "id";
}) {
  const cursor = decodeCursor(options.cursor);
  const sort = options.sort ?? "state";
  const fingerprint = JSON.stringify({ state: options.state ?? null, group: options.group ?? null, groupId: options.groupId ?? null, enabled: options.enabled ?? null, sort });
  if (options.cursor && !cursor) throw new MonitorApiError("INVALID_REQUEST", "Cursor is invalid");
  const accepted = await loadAcceptedConfig();
  const ids = accepted.config.monitors.map((monitor) => monitor.id);
  const states = ids.length
    ? await db.select({
        id: monitorState.monitorId,
        state: monitorState.state,
        createdAt: monitorRegistry.firstSeenAt,
        updatedAt: monitorState.updatedAt,
      }).from(monitorState).innerJoin(monitorRegistry, eq(monitorRegistry.id, monitorState.monitorId))
        .where(inArray(monitorState.monitorId, ids))
    : [];
  const stateById = new Map(states.map((row) => [row.id, row]));
  const groupNames = new Map(accepted.config.groups.map((group) => [group.id, group.name]));
  const filtered = accepted.config.monitors
    .map((monitor) => {
      const runtime = stateById.get(monitor.id);
      return {
        ...monitor,
        group: monitor.groupId ? groupNames.get(monitor.groupId) ?? null : null,
        ...(runtime ? { state: runtime.state, createdAt: runtime.createdAt.toISOString(), updatedAt: runtime.updatedAt.toISOString() } : {}),
      };
    })
    .filter((monitor) => options.state === undefined || monitor.state === options.state)
    .filter((monitor) => options.group === undefined || monitor.group?.toLocaleLowerCase("en-US") === options.group.toLocaleLowerCase("en-US"))
    .filter((monitor) => options.groupId === undefined || monitor.groupId === options.groupId)
    .filter((monitor) => options.enabled === undefined || monitor.enabled === options.enabled);
  const keyFor = (monitor: (typeof filtered)[number]) => sort === "name"
    ? monitor.name.toLocaleLowerCase("en-US")
    : sort === "id"
      ? monitor.id
      : String(STATE_ORDER.indexOf((monitor.state ?? "PENDING") as MonitorStateValue)).padStart(2, "0") + "\0" + monitor.name.toLocaleLowerCase("en-US");
  const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  const sorted = filtered.sort((a, b) => compareText(keyFor(a), keyFor(b)) || compareText(a.id, b.id));
  let after = sorted;
  if (cursor) {
    const separator = cursor.sort.indexOf("\0");
    if (separator < 0 || cursor.sort.slice(0, separator) !== fingerprint) throw new MonitorApiError("INVALID_REQUEST", "Cursor is invalid for these filters");
    const cursorKey = cursor.sort.slice(separator + 1);
    after = sorted.filter((monitor) => compareText(keyFor(monitor), cursorKey) > 0 || (keyFor(monitor) === cursorKey && compareText(monitor.id, cursor.id) > 0));
  }
  const page = after.slice(0, options.limit);
  const last = page.at(-1);
  const next = after.length > page.length && last ? encodeCursor({ sort: `${fingerprint}\0${keyFor(last)}`, id: last.id }) : null;
  return { monitors: page, nextCursor: next };
}

export async function testMonitor(id: string) {
  const accepted = await loadAcceptedConfig();
  const monitor = accepted.config.monitors.find((item) => item.id === id);
  if (!monitor) throw new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found");
  const result = await runManualCheck(monitor.url, {
    method: monitor.method,
    timeoutMs: monitor.timeoutMs,
    expectedStatus: monitor.expectedStatus,
    userAgent: accepted.config.settings.userAgent,
  });
  return {
    successful: result.success,
    method: result.method,
    finalUrl: result.finalUrl,
    statusCode: result.statusCode,
    latencyMs: result.latencyMs,
    redirectCount: result.redirectCount,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
  };
}
