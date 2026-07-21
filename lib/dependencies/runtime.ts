import "server-only"

import { requireAcceptedConfig } from "@/lib/api/config-mutation"
import { db } from "@/lib/db/client"
import { queryExecutor } from "@/lib/db/query-executor"
import {
  type DeliverySummary,
  deliverPendingNotifications,
} from "@/lib/notifications/delivery"
import { createResendSender } from "@/lib/notifications/provider"
import { reconcileStaleClaims, type SqlExecutor } from "@/lib/notifications/sql"
import { ORDINARY_NOTIFICATION_EVENT_TYPES } from "@/lib/notifications/types"
import { requirePulseReleaseId } from "@/lib/release/id"
import { runCronCoordinator } from "@/lib/scheduler/cron-coordinator"
import { DEPENDENCY_LEASE, type LeaseStore } from "@/lib/scheduler/lease"
import type { CronRunCounts, CronRunStore } from "@/lib/scheduler/run-record"
import { createSqlCronRunStore, createSqlLeaseStore } from "@/lib/scheduler/sql"

import { createSqlCatalogSyncStore, syncCatalog } from "./catalog-sync"
import { loadCatalogManifest } from "./manifest"
import { applyPollOutcome, createSqlPersistStore } from "./persist"
import {
  type PollerSourceRow,
  type PollerStore,
  pollDueSources,
} from "./poller"
import type { DependencyAdapterName } from "./types"

// Dependency cron lifecycle: acquire lease dependency-check, insert a
// check-dependencies cron_runs row for the scheduled minute, run work, then
// complete or fail that row and release the lease.

/**
 * Work budget for the dependency cron. The route maxDuration is 60s. This
 * reserves headroom for outbox reconciliation, delivery, run finalization,
 * and lease release after the poll pool settles.
 */
export const DEPENDENCY_WORK_BUDGET_MS = 52_000

// A due source's next_poll_at is advanced to a near-future claim floor in the
// same statement that selects it, so a second invocation overlapping this one
// does not re-select and double-poll the same source. This is defense in depth
// beyond the process lease, for when the lease holder is hard-killed after
// maxDuration without releasing, or work overruns the lease. The claim is a
// floor, not a replacement: applyPollOutcome rewrites next_poll_at with the real
// operational or active cadence (computeNextPollAt) after the poll resolves, so
// a completed poll always reschedules from the manifest cadence and only a lost
// run leaves the claim floor standing. This mirrors the outbox claim
// (CLAIM_NOTIFICATIONS_SQL in lib/notifications/sql.ts), a due CTE under
// for update skip locked feeding an update ... returning.
const DUE_SOURCE_CLAIM_INFLIGHT_MS = 60_000

export const CLAIM_DUE_SOURCES_SQL = `
with due as (
  select ds.id
  from dependency_sources ds
  where ds.enabled = true
    and (ds.next_poll_at is null or ds.next_poll_at <= $1)
    and exists (
      select 1
      from dependency_catalog dc
      join dependencies d on d.catalog_id = dc.id and d.removed_at is null
      where dc.source_id = ds.id
    )
  order by ds.next_poll_at nulls first, ds.id
  for update of ds skip locked
)
update dependency_sources as ds
set next_poll_at = $2
from due
where ds.id = due.id
returning ds.id, ds.provider_name, ds.adapter, ds.current_url, ds.incidents_url,
          ds.status_page_url, ds.allowed_hosts, ds.config, ds.etag, ds.last_modified,
          ds.consecutive_failures, ds.last_success_at
`

interface DueSourceRow {
  id: string
  provider_name: string
  adapter: DependencyAdapterName
  current_url: string
  incidents_url: string | null
  status_page_url: string
  allowed_hosts: string[]
  config: unknown
  etag: string | null
  last_modified: string | null
  consecutive_failures: number
  last_success_at: Date | null
}

/**
 * Enabled sources with at least one installed, non-removed dependency and
 * next_poll_at due, claimed atomically so a concurrent invocation cannot
 * re-select them (see CLAIM_DUE_SOURCES_SQL). Polling cadence fields live only
 * in the manifest (not the DB contract), so each row is enriched from the
 * shipped catalog by source id.
 */
export function createDueSourceStore(executor: SqlExecutor): PollerStore {
  return {
    async claimDueSources(now: Date): Promise<PollerSourceRow[]> {
      const manifest = loadCatalogManifest()
      const manifestBySourceId = new Map(
        manifest.sources.map((source) => [source.id, source])
      )
      const claimUntil = new Date(now.getTime() + DUE_SOURCE_CLAIM_INFLIGHT_MS)

      const rows = await executor.query<DueSourceRow>(CLAIM_DUE_SOURCES_SQL, [
        now,
        claimUntil,
      ])

      const due: PollerSourceRow[] = []
      for (const row of rows) {
        const manifestSource = manifestBySourceId.get(row.id)
        // syncCatalog disables any source dropped from the manifest on the same
        // version change that drops it, so an enabled row missing from the
        // manifest here would mean sync has not yet run for the current
        // manifest. Skip rather than guess a polling cadence for it. The claim
        // above already advanced its next_poll_at, so it simply retries after
        // the in-flight interval once sync catches up.
        if (!manifestSource) {
          continue
        }
        due.push({
          id: row.id,
          provider: row.provider_name,
          adapter: row.adapter,
          currentUrl: row.current_url,
          incidentsUrl: row.incidents_url,
          statusPageUrl: row.status_page_url,
          allowedHosts: row.allowed_hosts,
          config: row.config as Record<string, unknown>,
          etag: row.etag,
          lastModified: row.last_modified,
          consecutiveFailures: row.consecutive_failures,
          lastSuccessAt: row.last_success_at,
          operationalPollSeconds: manifestSource.operationalPollSeconds,
          activePollSeconds: manifestSource.activePollSeconds,
          staleAfterSeconds: manifestSource.staleAfterSeconds,
        })
      }
      return due
    },
  }
}

export type DependencyCronRunResult =
  | { status: "lease-held" }
  | { status: "duplicate"; runId: string }
  | {
      status: "completed"
      runId: string
      counts: CronRunCounts
      catalogSynced: boolean
      sourcesDue: number
      polled: number
      notModified: number
      failed: number
      skipped: number
      staleClaims: number
      delivery: DeliverySummary
    }
  | { status: "failed"; runId: string; error: string }

export interface DependencyCronCoordinatorDeps {
  leases: LeaseStore
  runs: CronRunStore
  // Deployment identity recorded on the cron_runs row for release-bound proof.
  releaseId: string
  syncCatalog: () => Promise<{ synced: boolean }>
  loadDefaultRecipients: () => Promise<string[]>
  poll: (
    defaultRecipients: string[],
    deadlineAtMs: number
  ) => Promise<{
    sourcesDue: number
    polled: number
    notModified: number
    failed: number
    skipped: number
  }>
  reconcileOutbox: (now: Date) => Promise<number>
  deliverOutbox: () => Promise<DeliverySummary>
  now?: () => Date
  nowMs?: () => number
  createId?: () => string
  /** Absolute work deadline. Defaults to start + DEPENDENCY_WORK_BUDGET_MS. */
  deadlineAtMs?: number
}

/** Map domain poll counters into the four generic cron_runs columns. */
export function toDependencyCronRunCounts(poll: {
  sourcesDue: number
  polled: number
  notModified: number
  failed: number
  skipped: number
}): CronRunCounts {
  return {
    monitorCount: poll.sourcesDue,
    successCount: poll.polled,
    failureCount: poll.failed,
    skippedCount: poll.notModified + poll.skipped,
  }
}

/**
 * The testable core: lease, scheduled-minute identity, catalog sync, poll,
 * outbox reconcile and delivery. Collaborators are injected so the sequence is
 * unit-testable without a database.
 */
export async function runDependencyCronCoordinator(
  deps: DependencyCronCoordinatorDeps
): Promise<DependencyCronRunResult> {
  const nowMs = deps.nowMs ?? Date.now
  const invocationStartedAtMs = nowMs()

  return runCronCoordinator(
    {
      leases: deps.leases,
      runs: deps.runs,
      leaseName: DEPENDENCY_LEASE,
      jobName: "check-dependencies",
      releaseId: deps.releaseId,
      now: deps.now,
      createId: deps.createId,
    },
    async ({ progress }) => {
      const deadlineAtMs = Math.min(
        deps.deadlineAtMs ?? Number.POSITIVE_INFINITY,
        invocationStartedAtMs + DEPENDENCY_WORK_BUDGET_MS
      )

      const syncResult = await deps.syncCatalog()
      const defaultRecipients = await deps.loadDefaultRecipients()

      let pollResult: {
        sourcesDue: number
        polled: number
        notModified: number
        failed: number
        skipped: number
      }
      try {
        pollResult = await deps.poll(defaultRecipients, deadlineAtMs)
      } catch (error) {
        const partial =
          error &&
          typeof error === "object" &&
          "pollCounts" in error &&
          error.pollCounts &&
          typeof error.pollCounts === "object"
            ? (error.pollCounts as {
                sourcesDue: number
                polled: number
                notModified: number
                failed: number
                skipped: number
              })
            : null
        if (partial) {
          progress.record(toDependencyCronRunCounts(partial))
        }
        throw error
      }

      const counts = toDependencyCronRunCounts(pollResult)
      // Record before outbox reconciliation, delivery, and completion so a
      // late failure still persists real poll counts instead of zeros.
      progress.record(counts)

      const now = deps.now ?? (() => new Date())
      const staleClaims = await deps.reconcileOutbox(now())
      const delivery = await deps.deliverOutbox()

      return {
        counts,
        catalogSynced: syncResult.synced,
        sourcesDue: pollResult.sourcesDue,
        polled: pollResult.polled,
        notModified: pollResult.notModified,
        failed: pollResult.failed,
        skipped: pollResult.skipped,
        staleClaims,
        delivery,
      }
    }
  )
}

export async function runDependencyCron(): Promise<DependencyCronRunResult> {
  const manifest = loadCatalogManifest()
  const persistStore = createSqlPersistStore(db)

  return runDependencyCronCoordinator({
    leases: createSqlLeaseStore(queryExecutor),
    runs: createSqlCronRunStore(queryExecutor),
    releaseId: requirePulseReleaseId(),
    syncCatalog: () => syncCatalog(createSqlCatalogSyncStore(db), manifest),
    loadDefaultRecipients: async () =>
      (await requireAcceptedConfig()).config.settings.defaultRecipients,
    poll: (defaultRecipients, deadlineAtMs) =>
      pollDueSources({
        store: createDueSourceStore(queryExecutor),
        deadlineAtMs,
        persist: async (outcome, source, now) => {
          await applyPollOutcome(persistStore, outcome, source, {
            now,
            defaultRecipients,
          })
        },
      }),
    reconcileOutbox: (now) =>
      reconcileStaleClaims(queryExecutor, now, undefined, {
        eventTypes: ORDINARY_NOTIFICATION_EVENT_TYPES,
      }),
    deliverOutbox: () =>
      deliverPendingNotifications(
        {
          db: queryExecutor,
          sender: createResendSender({
            apiKey: process.env.RESEND_API_KEY ?? "",
            from: process.env.RESEND_FROM_EMAIL ?? "",
          }),
          appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
          log: (event) => console.info(JSON.stringify(event)),
        },
        { eventTypes: ORDINARY_NOTIFICATION_EVENT_TYPES }
      ),
  })
}
