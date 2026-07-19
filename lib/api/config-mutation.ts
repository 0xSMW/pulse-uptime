import "server-only";

import { randomUUID } from "node:crypto";
import { desc, eq, sql as drizzleSql } from "drizzle-orm";

import { evaluateDestructiveChange, exportDeclarativeConfig, hashMonitoringConfig, validateMonitoringConfig, type MonitoringConfig } from "@/lib/config";
import { db, type DatabaseHandle, type DatabaseTransaction } from "@/lib/db/client";
import { configChangeApprovals, monitoringConfigSnapshots } from "@/lib/db/schema";
import { synchronizeRegistry as syncRegistryRows } from "@/lib/scheduler/registry-sync";

export type AcceptedSnapshot = { config: MonitoringConfig; hash: string };
type DbTransaction = DatabaseTransaction;

export class ConfigMutationError extends Error {
  constructor(readonly code: "CONFIGURATION_UNAVAILABLE" | "EDGE_CONFIG_UNAVAILABLE", message: string) {
    super(message); this.name = "ConfigMutationError";
  }
}

export async function loadAcceptedConfig(executor: typeof db = db): Promise<AcceptedSnapshot> {
  const [row] = await executor.select({ configJson: monitoringConfigSnapshots.configJson, configHash: monitoringConfigSnapshots.configHash })
    .from(monitoringConfigSnapshots).where(eq(monitoringConfigSnapshots.status, "accepted"))
    .orderBy(desc(monitoringConfigSnapshots.acceptedAt), desc(monitoringConfigSnapshots.seenAt)).limit(1);
  if (!row) throw new ConfigMutationError("CONFIGURATION_UNAVAILABLE", "No accepted monitoring configuration is available");
  try {
    const raw = row.configJson as Parameters<typeof hashMonitoringConfig>[0];
    const config = validateMonitoringConfig(row.configJson);
    if (hashMonitoringConfig(raw) !== row.configHash) throw new Error("hash mismatch");
    return { config, hash: row.configHash };
  } catch {
    throw new ConfigMutationError("CONFIGURATION_UNAVAILABLE", "Accepted monitoring configuration is invalid");
  }
}

async function writeEdgeConfig(config: MonitoringConfig): Promise<void> {
  const configId = process.env.EDGE_CONFIG_ID; const token = process.env.VERCEL_API_TOKEN;
  if (!configId || !token) throw new ConfigMutationError("EDGE_CONFIG_UNAVAILABLE", "Edge Config is unavailable");
  const teamQuery = process.env.VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : "";
  let response: Response;
  try {
    response = await fetch(`https://api.vercel.com/v1/edge-config/${encodeURIComponent(configId)}/items${teamQuery}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ operation: "upsert", key: "monitoring", value: config }] }), signal: AbortSignal.timeout(8_000),
    });
  } catch { throw new ConfigMutationError("EDGE_CONFIG_UNAVAILABLE", "Could not update Edge Config"); }
  if (!response.ok) throw new ConfigMutationError("EDGE_CONFIG_UNAVAILABLE", "Could not update Edge Config");
}

export async function synchronizeRegistry(tx: DbTransaction, config: MonitoringConfig, hash: string, now: Date): Promise<void> {
  await syncRegistryRows(tx, config, hash, now, {
    trackExceptions: false,
    assertIncidentResolution: false,
  });
}

export async function mutateConfig(principalKey: string, mutator: (config: MonitoringConfig) => MonitoringConfig, handle: DatabaseHandle = db): Promise<MonitoringConfig> {
  return handle.transaction(async (tx) => {
    await tx.execute(drizzleSql`select pg_advisory_xact_lock(hashtext('pulse:configuration'))`);
    const current = await loadAcceptedConfig(tx as unknown as typeof db);
    const target = validateMonitoringConfig(mutator(current.config));
    const hash = hashMonitoringConfig(target);
    if (hash === current.hash) return current.config;
    const now = new Date();
    const destructive = evaluateDestructiveChange(exportDeclarativeConfig(current.config), exportDeclarativeConfig(target));
    if (destructive.required) await tx.insert(configChangeApprovals).values({ id: randomUUID(), targetConfigHash: hash, action: "bulk_archive", createdByPrincipal: principalKey, createdAt: now, expiresAt: new Date(now.getTime() + 600_000), consumedAt: now });
    await tx.insert(monitoringConfigSnapshots).values({ id: randomUUID(), configVersion: target.configVersion, configHash: hash, configJson: target, status: "accepted", source: "api", seenAt: now, acceptedAt: now });
    await synchronizeRegistry(tx, target, hash, now);
    // writeEdgeConfig is an external HTTP call and cannot be rolled back, so it runs last,
    // after every statement in this transaction that could still abort it. Only the
    // caller's completion write and commit remain between it and durability.
    await writeEdgeConfig(target);
    return target;
  });
}

export function nextConfig(current: MonitoringConfig, patch: Partial<Pick<MonitoringConfig, "groups" | "monitors">>): MonitoringConfig {
  return { ...current, ...patch, schemaVersion: 2, configVersion: current.configVersion + 1 };
}
