import "server-only";

import { randomUUID } from "node:crypto";

import { requireAcceptedConfig } from "@/lib/api/config-mutation";
import { db } from "@/lib/db/client";
import { deliverPendingNotifications, type DeliverySummary } from "@/lib/notifications/delivery";
import { ORDINARY_NOTIFICATION_EVENT_TYPES } from "@/lib/notifications/types";
import { createResendSender } from "@/lib/notifications/provider";
import { reconcileStaleClaims, type SqlExecutor } from "@/lib/notifications/sql";
import { requirePulseReleaseId } from "@/lib/release/id";
import { queryExecutor } from "@/lib/scheduler/runtime";
import { createSqlLeaseStore } from "@/lib/scheduler/sql";
import { scheduledMinuteAt } from "@/lib/scheduler/time";

import { createSqlCatalogSyncStore, syncCatalog } from "./catalog-sync";
import { loadCatalogManifest } from "./manifest";
import { createSqlPersistStore, persistSnapshot } from "./persist";
import { pollDueSources, type PollerSourceRow, type PollerStore } from "./poller";
import type { DependencyAdapterName } from "./types";

// Mirrors runMonitoringCron (lib/scheduler/runtime.ts) but shares no lease,
// deadline, or transaction with it, per the doc's isolation requirement:
// its own lease name, its own cron_runs job name, its own SQL store.
//
// withLease (lib/scheduler/lease.ts) hardcodes a 90s duration for every
// caller, and CronJobName (lib/scheduler/run-record.ts) is a closed union
// that doesn't include "check-dependencies". Both are outside this phase's
// owned paths, so this module reimplements the same acquire/release and
// start/complete/fail shapes locally against the existing job_leases and
// cron_runs tables rather than widening shared types it doesn't own.

const DEPENDENCY_LEASE = "dependency-check";
// The lease must outlive a maximal run so a slow run never loses exclusivity.
// The check-dependencies route (app/api/cron/check-dependencies/route.ts) caps
// a run at maxDuration = 60s, so a 90s lease leaves a 30s margin above the
// worst case. This mirrors the monitoring cron, whose 60s route holds the 90s
// LEASE_DURATION_MS in lib/scheduler/lease.ts. A shorter lease would expire
// mid-run and let the next minute's invocation steal it and double-poll
// overlapping sources concurrently with the still-running first run.
const DEPENDENCY_LEASE_DURATION_MS = 90_000;
const DEPENDENCY_CRON_JOB_NAME = "check-dependencies";

interface DependencyLeaseStore {
  acquire(name: string, ownerId: string, durationMs: number): Promise<boolean>;
  release(name: string, ownerId: string): Promise<void>;
}

async function withDependencyLease<T>(
  store: DependencyLeaseStore,
  ownerId: string,
  work: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  if (!(await store.acquire(DEPENDENCY_LEASE, ownerId, DEPENDENCY_LEASE_DURATION_MS))) return { acquired: false };
  try {
    return { acquired: true, value: await work() };
  } finally {
    await store.release(DEPENDENCY_LEASE, ownerId);
  }
}

interface DependencyCronRunCounts {
  sourcesDue: number;
  polled: number;
  notModified: number;
  failed: number;
}

function createDependencyCronRunStore(executor: SqlExecutor) {
  return {
    async start(input: {
      id: string;
      scheduledMinute: Date;
      startedAt: Date;
      releaseId: string;
    }): Promise<boolean> {
      const rows = await executor.query<{ id: string }>(
        `insert into cron_runs (id, job_name, scheduled_minute, status, started_at, monitor_count, success_count, failure_count, skipped_count, release_id)
         values ($1, $2, $3, 'running', $4, 0, 0, 0, 0, $5)
         on conflict (job_name, scheduled_minute) do nothing returning id`,
        [input.id, DEPENDENCY_CRON_JOB_NAME, input.scheduledMinute, input.startedAt, input.releaseId],
      );
      return rows.length === 1;
    },
    async complete(id: string, completedAt: Date, counts: DependencyCronRunCounts): Promise<void> {
      await executor.query(
        `update cron_runs set status = 'completed', completed_at = $2,
         monitor_count = $3, success_count = $4, failure_count = $5, skipped_count = $6, error_message = null
         where id = $1 and status = 'running' returning id`,
        [id, completedAt, counts.sourcesDue, counts.polled, counts.failed, counts.notModified],
      );
    },
    async fail(id: string, completedAt: Date, errorMessage: string): Promise<void> {
      await executor.query(
        `update cron_runs set status = 'failed', completed_at = $2, error_message = $3
         where id = $1 and status = 'running' returning id`,
        [id, completedAt, errorMessage],
      );
    },
  };
}

// A due source's next_poll_at is advanced to a near-future claim floor in the
// same statement that selects it, so a second invocation overlapping this one
// does not re-select and double-poll the same source. This is defense in depth
// beyond the 90s process lease, for when the lease holder is hard-killed after
// maxDuration without releasing, or work overruns the lease. The claim is a
// floor, not a replacement: persistSnapshot rewrites next_poll_at with the real
// operational or active cadence (computeNextPollAt) after the poll resolves, so
// a completed poll always reschedules from the manifest cadence and only a lost
// run leaves the claim floor standing. This mirrors the outbox claim
// (CLAIM_NOTIFICATIONS_SQL in lib/notifications/sql.ts), a due CTE under
// for update skip locked feeding an update ... returning.
const DUE_SOURCE_CLAIM_INFLIGHT_MS = 60_000;

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
`;

interface DueSourceRow {
  id: string;
  provider_name: string;
  adapter: DependencyAdapterName;
  current_url: string;
  incidents_url: string | null;
  status_page_url: string;
  allowed_hosts: string[];
  config: unknown;
  etag: string | null;
  last_modified: string | null;
  consecutive_failures: number;
  last_success_at: Date | null;
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
    async listDueSources(now: Date): Promise<PollerSourceRow[]> {
      const manifest = loadCatalogManifest();
      const manifestBySourceId = new Map(manifest.sources.map((source) => [source.id, source]));
      const claimUntil = new Date(now.getTime() + DUE_SOURCE_CLAIM_INFLIGHT_MS);

      const rows = await executor.query<DueSourceRow>(CLAIM_DUE_SOURCES_SQL, [now, claimUntil]);

      const due: PollerSourceRow[] = [];
      for (const row of rows) {
        const manifestSource = manifestBySourceId.get(row.id);
        // syncCatalog disables any source dropped from the manifest on the same
        // version change that drops it, so an enabled row missing from the
        // manifest here would mean sync has not yet run for the current
        // manifest. Skip rather than guess a polling cadence for it. The claim
        // above already advanced its next_poll_at, so it simply retries after
        // the in-flight interval once sync catches up.
        if (!manifestSource) continue;
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
        });
      }
      return due;
    },
  };
}

export type DependencyCronRunResult =
  | { status: "lease-held" }
  | { status: "duplicate"; runId: string }
  | {
      status: "completed";
      runId: string;
      catalogSynced: boolean;
      sourcesDue: number;
      polled: number;
      notModified: number;
      failed: number;
      staleClaims: number;
      delivery: DeliverySummary;
    }
  | { status: "failed"; runId: string; error: string };

function safeCronError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown cron failure";
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

interface DependencyCronRunStore {
  start(input: {
    id: string;
    scheduledMinute: Date;
    startedAt: Date;
    releaseId: string;
  }): Promise<boolean>;
  complete(id: string, completedAt: Date, counts: DependencyCronRunCounts): Promise<void>;
  fail(id: string, completedAt: Date, errorMessage: string): Promise<void>;
}

export interface DependencyCronCoordinatorDeps {
  leases: DependencyLeaseStore;
  runs: DependencyCronRunStore;
  // Deployment identity recorded on the cron_runs row for release-bound proof.
  releaseId: string;
  syncCatalog(): Promise<{ synced: boolean }>;
  loadDefaultRecipients(): Promise<string[]>;
  poll(defaultRecipients: string[]): Promise<{ sourcesDue: number; polled: number; notModified: number; failed: number }>;
  reconcileOutbox(now: Date): Promise<number>;
  deliverOutbox(): Promise<DeliverySummary>;
  now?: () => Date;
  createId?: () => string;
}

/**
 * The testable core: mirrors runMonitoringCoordinator's split from
 * runMonitoringCron. Every collaborator is injected, so the lease/dedup/
 * catalog-sync/poll/deliver sequencing is unit-testable without a database.
 */
export async function runDependencyCronCoordinator(deps: DependencyCronCoordinatorDeps): Promise<DependencyCronRunResult> {
  const now = deps.now ?? (() => new Date());
  const createId = deps.createId ?? randomUUID;
  const startedAt = now();
  const ownerId = createId();
  const runId = createId();
  const scheduledMinute = scheduledMinuteAt(startedAt);

  const leased = await withDependencyLease(deps.leases, ownerId, async () => {
    if (!(await deps.runs.start({
      id: runId,
      scheduledMinute,
      startedAt,
      releaseId: deps.releaseId,
    }))) {
      return { status: "duplicate", runId } as const;
    }

    try {
      const syncResult = await deps.syncCatalog();
      const defaultRecipients = await deps.loadDefaultRecipients();
      const pollResult = await deps.poll(defaultRecipients);
      // Return stuck sending rows to pending before draining, so this cron
      // self-heals its own claims left behind when a prior invocation was
      // killed mid-send. Nothing else recovers them: the monitor and
      // maintenance paths reconcile on their own schedule but never for a run
      // that only this cron drives. Same staleness threshold as the monitor
      // cron (reconcileStaleClaims default).
      const staleClaims = await deps.reconcileOutbox(now());
      const delivery = await deps.deliverOutbox();

      await deps.runs.complete(runId, now(), {
        sourcesDue: pollResult.sourcesDue,
        polled: pollResult.polled,
        notModified: pollResult.notModified,
        failed: pollResult.failed,
      });

      return {
        status: "completed",
        runId,
        catalogSynced: syncResult.synced,
        sourcesDue: pollResult.sourcesDue,
        polled: pollResult.polled,
        notModified: pollResult.notModified,
        failed: pollResult.failed,
        staleClaims,
        delivery,
      } as const;
    } catch (error) {
      const message = safeCronError(error);
      await deps.runs.fail(runId, now(), message);
      return { status: "failed", runId, error: message } as const;
    }
  });

  return leased.acquired ? leased.value : { status: "lease-held" };
}

export async function runDependencyCron(): Promise<DependencyCronRunResult> {
  const manifest = loadCatalogManifest();
  const persistStore = createSqlPersistStore(db);

  return runDependencyCronCoordinator({
    leases: createSqlLeaseStore(queryExecutor),
    runs: createDependencyCronRunStore(queryExecutor),
    releaseId: requirePulseReleaseId(),
    syncCatalog: () => syncCatalog(createSqlCatalogSyncStore(db), manifest),
    loadDefaultRecipients: async () => (await requireAcceptedConfig()).config.settings.defaultRecipients,
    poll: (defaultRecipients) => pollDueSources({
      store: createDueSourceStore(queryExecutor),
      persist: async (outcome, source, now) => {
        await persistSnapshot(persistStore, outcome, source, { now, defaultRecipients });
      },
    }),
    reconcileOutbox: (now) => reconcileStaleClaims(queryExecutor, now, undefined, {
      eventTypes: ORDINARY_NOTIFICATION_EVENT_TYPES,
    }),
    deliverOutbox: () => deliverPendingNotifications({
      db: queryExecutor,
      sender: createResendSender({ apiKey: process.env.RESEND_API_KEY ?? "", from: process.env.RESEND_FROM_EMAIL ?? "" }),
      appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
      log: (event) => console.info(JSON.stringify(event)),
    }, { eventTypes: ORDINARY_NOTIFICATION_EVENT_TYPES }),
  });
}
