import "server-only"

import { desc, eq } from "drizzle-orm"

import {
  hashMonitoringConfig,
  type MonitoringConfig,
  validateMonitoringConfig,
} from "@/lib/config"
import { db } from "@/lib/db/client"
import { monitoringConfigSnapshots } from "@/lib/db/schema"

export interface AcceptedSnapshot {
  config: MonitoringConfig
  hash: string
  acceptedAt: Date | null
}

type SnapshotReader = typeof db

// The accepted snapshot orders by acceptedAt then seenAt so two rows accepted in
// the same instant resolve deterministically, and it recomputes the config hash
// so a persisted configHash that no longer matches its configJson is rejected
// rather than trusted. Missing accepted row returns null. A present but invalid
// or hash-mismatched row throws.
async function readAcceptedSnapshot(
  executor: SnapshotReader = db
): Promise<AcceptedSnapshot | null> {
  const [row] = await executor
    .select({
      configJson: monitoringConfigSnapshots.configJson,
      configHash: monitoringConfigSnapshots.configHash,
      acceptedAt: monitoringConfigSnapshots.acceptedAt,
    })
    .from(monitoringConfigSnapshots)
    .where(eq(monitoringConfigSnapshots.status, "accepted"))
    .orderBy(
      desc(monitoringConfigSnapshots.acceptedAt),
      desc(monitoringConfigSnapshots.seenAt)
    )
    .limit(1)
  if (!row) {
    return null
  }
  const raw = row.configJson as Parameters<typeof hashMonitoringConfig>[0]
  const config = validateMonitoringConfig(row.configJson)
  if (hashMonitoringConfig(raw) !== row.configHash) {
    throw new Error("Accepted monitoring configuration hash is invalid")
  }
  return { config, hash: row.configHash, acceptedAt: row.acceptedAt ?? null }
}

export async function findAcceptedSnapshot(
  executor: SnapshotReader = db
): Promise<AcceptedSnapshot | null> {
  return readAcceptedSnapshot(executor)
}

export async function requireAcceptedSnapshot(
  executor: SnapshotReader = db
): Promise<AcceptedSnapshot> {
  const snapshot = await readAcceptedSnapshot(executor)
  if (!snapshot) {
    throw new Error("No accepted monitoring configuration is available")
  }
  return snapshot
}
