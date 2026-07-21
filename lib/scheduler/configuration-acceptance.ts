import "server-only"

import { randomUUID } from "node:crypto"

import { and, desc, eq, gt, isNull } from "drizzle-orm"

import { lockConfiguration } from "@/lib/api/configuration-lock"
import {
  type AcceptanceResult,
  evaluateConfigurationAcceptance,
  hashCanonical,
  type MonitoringConfig,
} from "@/lib/config"
import { findAcceptedSnapshot } from "@/lib/config/accepted-config"
import {
  type DatabaseHandle,
  type DatabaseTransaction,
  db,
} from "@/lib/db/client"
import {
  configChangeApprovals,
  configOperations,
  monitoringConfigSnapshots,
} from "@/lib/db/schema"

import { requireApprovalConsumption } from "./configuration"
import { synchronizeRegistry as syncRegistryRows } from "./registry-sync"

type DbTransaction = DatabaseTransaction

type AcceptanceOutcome =
  | {
      kind: "ready"
      result: Extract<AcceptanceResult, { status: "accepted" | "rejected" }>
    }
  | {
      kind: "unavailable"
      reason: string
    }

async function writeSnapshotObservation(
  tx: DbTransaction,
  options: {
    desired: unknown
    result: AcceptanceResult
    now: Date
  }
): Promise<void> {
  const { desired, result, now } = options
  if (result.status === "unavailable") {
    await tx.insert(monitoringConfigSnapshots).values({
      id: randomUUID(),
      configVersion: 0,
      configHash: hashCanonical(desired ?? null),
      configJson: desired ?? null,
      status: "rejected",
      rejectionReason: result.reason,
      source: "edge-config",
      seenAt: now,
      acceptedAt: null,
    })
    return
  }
  await tx.insert(monitoringConfigSnapshots).values({
    id: randomUUID(),
    configVersion: result.config.configVersion,
    configHash:
      result.status === "accepted"
        ? result.hash
        : (result.candidateHash ?? hashCanonical(desired ?? null)),
    configJson: desired ?? result.config,
    status: result.status,
    rejectionReason: result.status === "rejected" ? result.reason : null,
    source: "edge-config",
    seenAt: now,
    acceptedAt: result.status === "accepted" ? now : null,
  })
  if (result.status === "accepted") {
    await tx
      .update(configOperations)
      .set({ state: "accepted", acceptedAt: now })
      .where(
        and(
          eq(configOperations.targetConfigHash, result.hash),
          eq(configOperations.state, "written")
        )
      )
  } else if (result.candidateHash) {
    await tx
      .update(configOperations)
      .set({ state: "rejected", rejectionReason: result.reason })
      .where(
        and(
          eq(configOperations.targetConfigHash, result.candidateHash),
          eq(configOperations.state, "written")
        )
      )
  }
}

/**
 * Accept a previously fetched desired document under the shared configuration
 * lock. Re-reads the accepted DB snapshot through the same transaction, so
 * API mutations and cron acceptance serialize: snapshot write, approval
 * consumption, and registry sync commit together.
 *
 * Edge Config I/O must stay outside this call so lock hold time is only the
 * DB critical section.
 */
export async function acceptDesiredConfiguration(
  desired: unknown,
  now: Date,
  handle: DatabaseHandle = db
): Promise<MonitoringConfig> {
  const outcome = await handle.transaction(
    async (tx): Promise<AcceptanceOutcome> => {
      await lockConfiguration(tx)

      // Persisted rows are stamped with a timestamp taken after the lock is
      // held so the accepted snapshot ordering respects lock serialization. The
      // caller's now can predate a concurrent API mutation that acquired the
      // lock and committed first, which would sort this snapshot as older while
      // the registry sync reflects this config, so readers ordered by acceptedAt
      // would return the other config than the one the registry runs.
      const writtenAt = new Date()

      const snapshot = await findAcceptedSnapshot(tx as unknown as typeof db)
      const previous = snapshot
        ? { config: snapshot.config, hash: snapshot.hash }
        : null

      let result = evaluateConfigurationAcceptance(desired, previous, { now })

      if (result.status === "unavailable") {
        await writeSnapshotObservation(tx, { desired, result, now: writtenAt })
        return { kind: "unavailable", reason: result.reason }
      }

      let approvalId: string | null = null
      if (
        result.status === "rejected" &&
        result.reason === "DESTRUCTIVE_APPROVAL_REQUIRED" &&
        result.candidateHash
      ) {
        const [approval] = await tx
          .select()
          .from(configChangeApprovals)
          .where(
            and(
              eq(configChangeApprovals.targetConfigHash, result.candidateHash),
              eq(configChangeApprovals.action, "destructive_config_change"),
              isNull(configChangeApprovals.consumedAt),
              gt(configChangeApprovals.expiresAt, now)
            )
          )
          .orderBy(desc(configChangeApprovals.createdAt))
          .limit(1)
        if (approval) {
          approvalId = approval.id
          result = evaluateConfigurationAcceptance(desired, previous, {
            approval,
            now,
          })
        }
      }

      if (result.status === "unavailable") {
        await writeSnapshotObservation(tx, { desired, result, now: writtenAt })
        return { kind: "unavailable", reason: result.reason }
      }

      const guarded = await requireApprovalConsumption({
        result,
        desired,
        previous,
        now,
        consume: async () => {
          if (!approvalId) {
            return false
          }
          const rows = await tx
            .update(configChangeApprovals)
            .set({ consumedAt: now })
            .where(
              and(
                eq(configChangeApprovals.id, approvalId),
                isNull(configChangeApprovals.consumedAt),
                gt(configChangeApprovals.expiresAt, now)
              )
            )
            .returning({ id: configChangeApprovals.id })
          return rows.length === 1
        },
      })

      if (guarded.status === "unavailable") {
        await writeSnapshotObservation(tx, {
          desired,
          result: guarded,
          now: writtenAt,
        })
        return { kind: "unavailable", reason: guarded.reason }
      }

      await writeSnapshotObservation(tx, {
        desired,
        result: guarded,
        now: writtenAt,
      })
      // Registry sync shares the locked transaction so snapshot and registry
      // hashes cannot diverge from concurrent API mutations.
      await syncRegistryRows(
        tx,
        guarded.config,
        guarded.hash,
        writtenAt,
        "runtime"
      )
      return { kind: "ready", result: guarded }
    }
  )

  if (outcome.kind === "unavailable") {
    console.error(
      JSON.stringify({ event: "config.rejected", errorCode: outcome.reason })
    )
    throw new Error(outcome.reason)
  }

  const { result } = outcome
  console[result.status === "accepted" ? "info" : "warn"](
    JSON.stringify({
      event:
        result.status === "accepted" ? "config.accepted" : "config.rejected",
      status: result.status,
      ...(result.status === "rejected" ? { errorCode: result.reason } : {}),
    })
  )
  if (result.status === "rejected") {
    console.warn(
      JSON.stringify({ event: "config.fallback_used", status: "active" })
    )
  }
  return result.config
}
