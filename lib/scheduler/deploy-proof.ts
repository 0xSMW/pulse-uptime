import "server-only"

import { and, desc, eq, gte, isNotNull } from "drizzle-orm"

import { db } from "@/lib/db/client"
import { cronRuns } from "@/lib/db/schema"

export const DEPLOY_PROOF_JOB_NAME = "monitor-check" as const

export interface DeployProofRunSnapshot {
  runId: string
  status: "running" | "completed" | "failed"
  scheduledMinute: Date
  startedAt: Date
  completedAt: Date | null
  releaseId: string | null
}

export interface DeployProofReady {
  status: "ready"
  releaseId: string
  runId: string
  scheduledMinute: Date
  startedAt: Date
  completedAt: Date
}

export interface DeployProofWaiting {
  status: "waiting"
  releaseId: string
  latest: DeployProofRunSnapshot | null
}

export type DeployProofResult = DeployProofReady | DeployProofWaiting

export interface DeployProofStore {
  findQualifyingCompleted: (input: {
    releaseId: string
    after: Date
  }) => Promise<DeployProofRunSnapshot | null>
  findLatestForRelease: (input: {
    releaseId: string
  }) => Promise<DeployProofRunSnapshot | null>
}

function mapRow(row: {
  id: string
  status: "running" | "completed" | "failed"
  scheduledMinute: Date
  startedAt: Date
  completedAt: Date | null
  releaseId: string | null
}): DeployProofRunSnapshot {
  return {
    runId: row.id,
    status: row.status,
    scheduledMinute: row.scheduledMinute,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    releaseId: row.releaseId,
  }
}

/**
 * Production store over cron_runs. Qualifying rows are completed monitor-check
 * runs for the current release with completed_at at or after the promotion
 * boundary. Null release_id historical rows never match.
 */
export function createSqlDeployProofStore(): DeployProofStore {
  return {
    async findQualifyingCompleted({ releaseId, after }) {
      const rows = await db
        .select({
          id: cronRuns.id,
          status: cronRuns.status,
          scheduledMinute: cronRuns.scheduledMinute,
          startedAt: cronRuns.startedAt,
          completedAt: cronRuns.completedAt,
          releaseId: cronRuns.releaseId,
        })
        .from(cronRuns)
        .where(
          and(
            eq(cronRuns.jobName, DEPLOY_PROOF_JOB_NAME),
            eq(cronRuns.releaseId, releaseId),
            eq(cronRuns.status, "completed"),
            isNotNull(cronRuns.completedAt),
            gte(cronRuns.completedAt, after)
          )
        )
        .orderBy(desc(cronRuns.completedAt))
        .limit(1)
      return rows[0] ? mapRow(rows[0]) : null
    },
    async findLatestForRelease({ releaseId }) {
      const rows = await db
        .select({
          id: cronRuns.id,
          status: cronRuns.status,
          scheduledMinute: cronRuns.scheduledMinute,
          startedAt: cronRuns.startedAt,
          completedAt: cronRuns.completedAt,
          releaseId: cronRuns.releaseId,
        })
        .from(cronRuns)
        .where(
          and(
            eq(cronRuns.jobName, DEPLOY_PROOF_JOB_NAME),
            eq(cronRuns.releaseId, releaseId)
          )
        )
        .orderBy(desc(cronRuns.startedAt))
        .limit(1)
      return rows[0] ? mapRow(rows[0]) : null
    },
  }
}

/**
 * Pure evaluation of release-bound deploy proof against an injected store.
 * Ready only when a completed monitor-check for this release finished at or
 * after the promotion boundary.
 */
export async function evaluateDeployProof(input: {
  releaseId: string
  after: Date
  store: DeployProofStore
}): Promise<DeployProofResult> {
  const qualifying = await input.store.findQualifyingCompleted({
    releaseId: input.releaseId,
    after: input.after,
  })
  if (qualifying?.completedAt) {
    return {
      status: "ready",
      releaseId: input.releaseId,
      runId: qualifying.runId,
      scheduledMinute: qualifying.scheduledMinute,
      startedAt: qualifying.startedAt,
      completedAt: qualifying.completedAt,
    }
  }
  const latest = await input.store.findLatestForRelease({
    releaseId: input.releaseId,
  })
  return {
    status: "waiting",
    releaseId: input.releaseId,
    latest,
  }
}

/** Parse the promotion boundary from the `after` query param. */
export function parsePromotionBoundary(raw: string | null): Date | null {
  if (raw === null || raw.trim().length === 0) {
    return null
  }
  const ms = Date.parse(raw)
  if (Number.isNaN(ms)) {
    return null
  }
  return new Date(ms)
}

export function serializeDeployProof(
  result: DeployProofResult
): Record<string, unknown> {
  if (result.status === "ready") {
    return {
      status: "ready",
      releaseId: result.releaseId,
      runId: result.runId,
      scheduledMinute: result.scheduledMinute.toISOString(),
      startedAt: result.startedAt.toISOString(),
      completedAt: result.completedAt.toISOString(),
    }
  }
  return {
    status: "waiting",
    releaseId: result.releaseId,
    latest: result.latest
      ? {
          runId: result.latest.runId,
          status: result.latest.status,
          scheduledMinute: result.latest.scheduledMinute.toISOString(),
          startedAt: result.latest.startedAt.toISOString(),
          completedAt: result.latest.completedAt?.toISOString() ?? null,
          releaseId: result.latest.releaseId,
        }
      : null,
  }
}
