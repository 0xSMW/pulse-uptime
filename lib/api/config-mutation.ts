import "server-only"

import { randomUUID } from "node:crypto"

import {
  type AcceptedConfigSnapshot,
  evaluateDestructiveChange,
  exportDeclarativeConfig,
  hashMonitoringConfig,
  type MonitoringConfig,
  validateMonitoringConfig,
} from "@/lib/config"
import { findAcceptedSnapshot } from "@/lib/config/accepted-config"
import { writeMonitoringEdgeConfig } from "@/lib/config/edge-config-write"
import {
  type DatabaseHandle,
  type DatabaseTransaction,
  db,
} from "@/lib/db/client"
import {
  configChangeApprovals,
  monitoringConfigSnapshots,
} from "@/lib/db/schema"
import { synchronizeRegistry as syncRegistryRows } from "@/lib/scheduler/registry-sync"

import { lockConfiguration } from "./configuration-lock"

type DbTransaction = DatabaseTransaction

export class ConfigMutationError extends Error {
  constructor(
    readonly code: "CONFIGURATION_UNAVAILABLE" | "EDGE_CONFIG_UNAVAILABLE",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "ConfigMutationError"
  }
}

export async function requireAcceptedConfig(
  executor: typeof db = db
): Promise<AcceptedConfigSnapshot> {
  let snapshot: Awaited<ReturnType<typeof findAcceptedSnapshot>>
  try {
    snapshot = await findAcceptedSnapshot(executor)
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: cause is threaded through the error options arg, biome only detects the native second-argument position
    throw new ConfigMutationError(
      "CONFIGURATION_UNAVAILABLE",
      "Accepted monitoring configuration is invalid",
      { cause: error }
    )
  }
  if (!snapshot) {
    throw new ConfigMutationError(
      "CONFIGURATION_UNAVAILABLE",
      "No accepted monitoring configuration is available"
    )
  }
  return { config: snapshot.config, hash: snapshot.hash }
}

async function writeEdgeConfig(config: MonitoringConfig): Promise<void> {
  try {
    await writeMonitoringEdgeConfig(config)
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: cause is threaded through the error options arg, biome only detects the native second-argument position
    throw new ConfigMutationError(
      "EDGE_CONFIG_UNAVAILABLE",
      "Could not update Edge Config",
      { cause: error }
    )
  }
}

async function synchronizeRegistry(
  tx: DbTransaction,
  config: MonitoringConfig,
  hash: string,
  now: Date
): Promise<void> {
  await syncRegistryRows(tx, config, hash, now, "api")
}

export async function mutateConfig(
  principalKey: string,
  mutator: (config: MonitoringConfig) => MonitoringConfig,
  handle: DatabaseHandle = db
): Promise<MonitoringConfig> {
  return handle.transaction(async (tx) => {
    await lockConfiguration(tx)
    const current = await requireAcceptedConfig(tx as unknown as typeof db)
    const target = validateMonitoringConfig(mutator(current.config))
    const hash = hashMonitoringConfig(target)
    if (hash === current.hash) {
      return current.config
    }
    const now = new Date()
    const destructive = evaluateDestructiveChange(
      exportDeclarativeConfig(current.config),
      exportDeclarativeConfig(target)
    )
    if (destructive.required) {
      await tx.insert(configChangeApprovals).values({
        id: randomUUID(),
        targetConfigHash: hash,
        action: "bulk_archive",
        createdByPrincipal: principalKey,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 600_000),
        consumedAt: now,
      })
    }
    await tx.insert(monitoringConfigSnapshots).values({
      id: randomUUID(),
      configVersion: target.configVersion,
      configHash: hash,
      configJson: target,
      status: "accepted",
      source: "api",
      seenAt: now,
      acceptedAt: now,
    })
    await synchronizeRegistry(tx, target, hash, now)
    // writeEdgeConfig is an external HTTP call and cannot be rolled back, so it runs last,
    // after every statement in this transaction that could still abort it. Only the
    // caller's completion write and commit remain between it and durability.
    await writeEdgeConfig(target)
    return target
  })
}

export function nextConfig(
  current: MonitoringConfig,
  patch: Partial<Pick<MonitoringConfig, "groups" | "monitors">>
): MonitoringConfig {
  return {
    ...current,
    ...patch,
    schemaVersion: 2,
    configVersion: current.configVersion + 1,
  }
}
