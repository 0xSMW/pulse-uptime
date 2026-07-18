import "server-only";

import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNull, sql as drizzleSql } from "drizzle-orm";
import { z } from "zod";

import { runManualCheck } from "@/lib/checker";
import {
  createMonitorWithDefaults,
  evaluateDestructiveChange,
  exportDeclarativeConfig,
  hashCanonical,
  hashMonitoringConfig,
  monitorConfigSchema,
  validateMonitoringConfig,
  type MonitorConfig,
  type MonitoringConfig,
} from "@/lib/config";
import { db } from "@/lib/db/client";
import {
  incidents,
  configChangeApprovals,
  monitorRegistry,
  monitoringConfigSnapshots,
  monitorState,
} from "@/lib/db/schema";
import { targetFor, transitionLifecycle } from "@/lib/scheduler/lifecycle";

import { decodeCursor, encodeCursor } from "./pagination";

const idSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).min(3).max(64);
const createSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(80),
  url: z.string(),
  enabled: z.boolean().optional(),
  group: z.string().trim().min(1).max(50).nullable().optional(),
  method: z.enum(["GET", "HEAD"]).optional(),
  intervalMinutes: z.union([z.literal(1), z.literal(5), z.literal(10), z.literal(15)]).optional(),
  timeoutMs: z.number().int().min(1_000).max(15_000).optional(),
  expectedStatus: z.object({ minimum: z.number().int(), maximum: z.number().int() }).strict().optional(),
  failureThreshold: z.number().int().min(1).max(5).optional(),
  recoveryThreshold: z.number().int().min(1).max(5).optional(),
  recipients: z.array(z.string()).max(20).optional(),
}).strict();

const patchSchema = createSchema.omit({ id: true }).partial().refine((value) => Object.keys(value).length > 0, {
  message: "At least one monitor field is required",
});

export class MonitorApiError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "MONITOR_NOT_FOUND" | "MONITOR_EXISTS" | "CONFIGURATION_UNAVAILABLE" | "EDGE_CONFIG_UNAVAILABLE", message: string) {
    super(message);
    this.name = "MonitorApiError";
  }
}

export function parseCreateMonitor(input: unknown): MonitorConfig {
  const value = createSchema.parse(input);
  return monitorConfigSchema.parse({ ...createMonitorWithDefaults(value), ...value });
}

export function parsePatchMonitor(input: unknown): z.infer<typeof patchSchema> {
  return patchSchema.parse(input);
}

export function mergeMonitorPatch(monitor: MonitorConfig, patch: z.infer<typeof patchSchema>): MonitorConfig {
  return monitorConfigSchema.parse({ ...monitor, ...patch, expectedStatus: patch.expectedStatus ?? monitor.expectedStatus });
}

type AcceptedSnapshot = { config: MonitoringConfig; hash: string };
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function loadAcceptedConfig(executor: typeof db = db): Promise<AcceptedSnapshot> {
  const [row] = await executor.select({
    configJson: monitoringConfigSnapshots.configJson,
    configHash: monitoringConfigSnapshots.configHash,
  }).from(monitoringConfigSnapshots).where(eq(monitoringConfigSnapshots.status, "accepted"))
    .orderBy(desc(monitoringConfigSnapshots.acceptedAt), desc(monitoringConfigSnapshots.seenAt)).limit(1);
  if (!row) throw new MonitorApiError("CONFIGURATION_UNAVAILABLE", "No accepted monitoring configuration is available");
  try {
    const config = validateMonitoringConfig(row.configJson);
    if (hashMonitoringConfig(config) !== row.configHash) {
      throw new MonitorApiError("CONFIGURATION_UNAVAILABLE", "Accepted monitoring configuration hash is invalid");
    }
    return { config, hash: row.configHash };
  } catch {
    throw new MonitorApiError("CONFIGURATION_UNAVAILABLE", "Accepted monitoring configuration is invalid");
  }
}

async function writeEdgeConfig(config: MonitoringConfig) {
  const configId = process.env.EDGE_CONFIG_ID;
  const token = process.env.VERCEL_API_TOKEN;
  if (!configId || !token) throw new MonitorApiError("EDGE_CONFIG_UNAVAILABLE", "Edge Config is unavailable");
  const teamQuery = process.env.VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : "";
  let response: Response;
  try {
    response = await fetch(`https://api.vercel.com/v1/edge-config/${encodeURIComponent(configId)}/items${teamQuery}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ operation: "upsert", key: "monitoring", value: config }] }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new MonitorApiError("EDGE_CONFIG_UNAVAILABLE", "Could not update Edge Config");
  }
  if (!response.ok) throw new MonitorApiError("EDGE_CONFIG_UNAVAILABLE", "Could not update Edge Config");
}

async function synchronizeRegistry(tx: DbTransaction, config: MonitoringConfig, hash: string, now: Date) {
  const applyLifecycle = async (id: string, enabled: boolean, archived: boolean) => {
    const [current] = await tx.select().from(monitorState).where(eq(monitorState.monitorId, id)).for("update");
    if (!current) throw new Error(`Monitor state not found: ${id}`);
    const mutation = transitionLifecycle(current, targetFor(enabled, archived), now);
    if (!mutation.changed) return;
    if (mutation.resolution) {
      await tx.update(incidents).set({ firstSuccessAt: mutation.resolution.resolvedAt, resolvedAt: mutation.resolution.resolvedAt, resolutionReason: mutation.resolution.reason, updatedAt: now })
        .where(and(eq(incidents.id, mutation.resolution.incidentId), isNull(incidents.resolvedAt)));
    }
    await tx.update(monitorState).set({ ...mutation.state, updatedAt: now }).where(eq(monitorState.monitorId, id));
  };
  for (const monitor of config.monitors) {
    await tx.insert(monitorRegistry).values({ id: monitor.id, name: monitor.name, url: monitor.url, groupName: monitor.group, enabled: monitor.enabled, configHash: hash, firstSeenAt: now, lastSeenAt: now, archivedAt: null })
      .onConflictDoUpdate({ target: monitorRegistry.id, set: { name: monitor.name, url: monitor.url, groupName: monitor.group, enabled: monitor.enabled, configHash: hash, lastSeenAt: now, archivedAt: null } });
    await tx.insert(monitorState).values({ monitorId: monitor.id, state: monitor.enabled ? "PENDING" : "PAUSED", updatedAt: now }).onConflictDoNothing();
    await applyLifecycle(monitor.id, monitor.enabled, false);
  }
  const ids = config.monitors.map((monitor) => monitor.id);
  const removed = await tx.update(monitorRegistry).set({ enabled: false, archivedAt: now, lastSeenAt: now })
    .where(and(isNull(monitorRegistry.archivedAt), ids.length ? drizzleSql`${monitorRegistry.id} <> all(${ids})` : drizzleSql`true`)).returning({ id: monitorRegistry.id });
  for (const monitor of removed) await applyLifecycle(monitor.id, false, true);
}

async function mutateConfig(principalKey: string, mutator: (config: MonitoringConfig) => MonitoringConfig): Promise<MonitorConfig[]> {
  return db.transaction(async (tx) => {
    await tx.execute(drizzleSql`select pg_advisory_xact_lock(hashtext('pulse:configuration'))`);
    const current = await loadAcceptedConfig(tx as unknown as typeof db);
    const target = validateMonitoringConfig(mutator(current.config));
    const hash = hashMonitoringConfig(target);
    if (hash === current.hash) return current.config.monitors;
    const now = new Date();
    const destructive = evaluateDestructiveChange(exportDeclarativeConfig(current.config), exportDeclarativeConfig(target));
    if (destructive.required) {
      await tx.insert(configChangeApprovals).values({
        id: randomUUID(),
        targetConfigHash: hash,
        action: "bulk_archive",
        createdByPrincipal: principalKey,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 10 * 60_000),
        consumedAt: now,
      });
    }
    await writeEdgeConfig(target);
    await tx.insert(monitoringConfigSnapshots).values({ id: randomUUID(), configVersion: target.configVersion, configHash: hash, configJson: target, status: "accepted", source: "api", seenAt: now, acceptedAt: now });
    await synchronizeRegistry(tx, target, hash, now);
    return target.monitors;
  });
}

function nextConfig(current: MonitoringConfig, monitors: MonitorConfig[]): MonitoringConfig {
  return { ...current, configVersion: current.configVersion + 1, monitors };
}

export async function createMonitor(input: unknown, principalKey: string) {
  const monitor = parseCreateMonitor(input);
  const monitors = await mutateConfig(principalKey, (current) => {
    const existing = current.monitors.find((item) => item.id === monitor.id);
    if (existing) {
      if (hashCanonical(existing) === hashCanonical(monitor)) return current;
      throw new MonitorApiError("MONITOR_EXISTS", "A monitor with this ID already exists");
    }
    return nextConfig(current, [...current.monitors, monitor]);
  });
  return monitors.find((item) => item.id === monitor.id)!;
}

export async function recoverCreatedMonitor(input: unknown) {
  const desired = parseCreateMonitor(input);
  const current = await loadAcceptedConfig();
  const existing = current.config.monitors.find((monitor) => monitor.id === desired.id);
  return existing && hashCanonical(existing) === hashCanonical(desired) ? existing : null;
}

export async function updateMonitor(id: string, input: unknown, principalKey: string) {
  const patch = parsePatchMonitor(input);
  const monitors = await mutateConfig(principalKey, (current) => {
    const existing = current.monitors.find((item) => item.id === id);
    if (!existing) throw new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found");
    return nextConfig(current, current.monitors.map((item) => item.id === id ? mergeMonitorPatch(item, patch) : item));
  });
  return monitors.find((item) => item.id === id)!;
}

export async function recoverUpdatedMonitor(id: string, input: unknown) {
  const patch = parsePatchMonitor(input);
  const current = await loadAcceptedConfig();
  const existing = current.config.monitors.find((monitor) => monitor.id === id);
  if (!existing) return null;
  return hashCanonical(mergeMonitorPatch(existing, patch)) === hashCanonical(existing) ? existing : null;
}

export async function deleteMonitor(id: string, principalKey: string) {
  try {
    await mutateConfig(principalKey, (current) => {
      if (!current.monitors.some((item) => item.id === id)) throw new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found");
      return nextConfig(current, current.monitors.filter((item) => item.id !== id));
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
  const monitors = await mutateConfig(principalKey, (current) => {
    if (!current.monitors.some((item) => item.id === id)) throw new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found");
    return nextConfig(current, current.monitors.map((item) => item.id === id ? { ...item, enabled } : item));
  });
  return monitors.find((item) => item.id === id)!;
}

export async function recoverMonitorEnabled(id: string, enabled: boolean) {
  const current = await loadAcceptedConfig();
  const monitor = current.config.monitors.find((item) => item.id === id);
  return monitor?.enabled === enabled ? monitor : null;
}

export async function getMonitor(id: string) {
  const accepted = await loadAcceptedConfig();
  const monitor = accepted.config.monitors.find((item) => item.id === id);
  if (!monitor) throw new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found");
  return monitor;
}

const STATE_ORDER = ["DOWN", "VERIFYING_DOWN", "VERIFYING_UP", "PENDING", "UP", "PAUSED", "ARCHIVED"] as const;
type MonitorStateValue = (typeof STATE_ORDER)[number];

export async function listMonitors(options: {
  cursor: string | null;
  limit: number;
  state?: MonitorStateValue;
  group?: string;
  enabled?: boolean;
  sort?: "state" | "name" | "id";
}) {
  const cursor = decodeCursor(options.cursor);
  const sort = options.sort ?? "state";
  const fingerprint = JSON.stringify({ state: options.state ?? null, group: options.group ?? null, enabled: options.enabled ?? null, sort });
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
  const filtered = accepted.config.monitors
    .map((monitor) => {
      const runtime = stateById.get(monitor.id);
      return {
        ...monitor,
        ...(runtime ? { state: runtime.state, createdAt: runtime.createdAt.toISOString(), updatedAt: runtime.updatedAt.toISOString() } : {}),
      };
    })
    .filter((monitor) => options.state === undefined || monitor.state === options.state)
    .filter((monitor) => options.group === undefined || monitor.group === options.group)
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
