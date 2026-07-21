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

// The accepted snapshot orders by acceptedAt then seenAt. Every writer stamps
// acceptedAt from the lock-serialized database clock after acquiring the
// configuration lock, and the lock releases only at commit, so the later
// committed snapshot carries a strictly greater acceptedAt (a durable commit
// spans more than the millisecond resolution of a Date) and this reader returns
// the config the last committed registry sync wrote. seenAt is a stable
// secondary sort. The reader recomputes the config hash so a persisted
// configHash that no longer matches its configJson is rejected rather than
// trusted. Missing accepted row returns null. A present but invalid or
// hash-mismatched row throws.
export async function findAcceptedSnapshot(
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
