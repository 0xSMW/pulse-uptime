import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, isNull, lte, or } from "drizzle-orm";

import { loadAcceptedConfig } from "@/lib/api/config-mutation";
import { db } from "@/lib/db/client";
import { dependencies, dependencyCatalog, dependencySources } from "@/lib/db/schema";
import { deliverPendingNotifications, type DeliverySummary } from "@/lib/notifications/delivery";
import { createResendSender } from "@/lib/notifications/provider";
import type { SqlExecutor } from "@/lib/notifications/sql";
import { queryExecutor } from "@/lib/scheduler/runtime";
import { createSqlLeaseStore } from "@/lib/scheduler/sql";
import { scheduledMinuteAt } from "@/lib/scheduler/time";

import { createSqlCatalogSyncStore, syncCatalog } from "./catalog-sync";
import { loadCatalogManifest } from "./manifest";
import { createSqlPersistStore, persistSnapshot } from "./persist";
import { pollDueSources, type PollerSourceRow, type PollerStore } from "./poller";

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
    async start(input: { id: string; scheduledMinute: Date; startedAt: Date }): Promise<boolean> {
      const rows = await executor.query<{ id: string }>(
        `insert into cron_runs (id, job_name, scheduled_minute, status, started_at, monitor_count, success_count, failure_count, skipped_count)
         values ($1, $2, $3, 'running', $4, 0, 0, 0, 0)
         on conflict (job_name, scheduled_minute) do nothing returning id`,
        [input.id, DEPENDENCY_CRON_JOB_NAME, input.scheduledMinute, input.startedAt],
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

/** Enabled sources with at least one installed, non-removed dependency and next_poll_at due. Polling cadence fields live only in the manifest (not the DB contract), so each row is enriched from the shipped catalog by source id. */
async function listDueSources(now: Date): Promise<PollerSourceRow[]> {
  const manifest = loadCatalogManifest();
  const manifestBySourceId = new Map(manifest.sources.map((source) => [source.id, source]));

  const rows = await db.selectDistinct({
    id: dependencySources.id,
    provider: dependencySources.providerName,
    adapter: dependencySources.adapter,
    currentUrl: dependencySources.currentUrl,
    incidentsUrl: dependencySources.incidentsUrl,
    statusPageUrl: dependencySources.statusPageUrl,
    allowedHosts: dependencySources.allowedHosts,
    config: dependencySources.config,
    etag: dependencySources.etag,
    lastModified: dependencySources.lastModified,
    consecutiveFailures: dependencySources.consecutiveFailures,
    lastSuccessAt: dependencySources.lastSuccessAt,
  }).from(dependencySources)
    .innerJoin(dependencyCatalog, eq(dependencyCatalog.sourceId, dependencySources.id))
    .innerJoin(dependencies, and(eq(dependencies.catalogId, dependencyCatalog.id), isNull(dependencies.removedAt)))
    .where(and(
      eq(dependencySources.enabled, true),
      or(isNull(dependencySources.nextPollAt), lte(dependencySources.nextPollAt, now)),
    ));

  const due: PollerSourceRow[] = [];
  for (const row of rows) {
    const manifestSource = manifestBySourceId.get(row.id);
    // syncCatalog disables any source dropped from the manifest on the same
    // version change that drops it, so an enabled row missing from the
    // manifest here would mean sync has not yet run for the current
    // manifest. Skip rather than guess a polling cadence for it.
    if (!manifestSource) continue;
    due.push({
      ...row,
      config: row.config as Record<string, unknown>,
      operationalPollSeconds: manifestSource.operationalPollSeconds,
      activePollSeconds: manifestSource.activePollSeconds,
      staleAfterSeconds: manifestSource.staleAfterSeconds,
    });
  }
  return due;
}

const pollerStore: PollerStore = { listDueSources };

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
      delivery: DeliverySummary;
    }
  | { status: "failed"; runId: string; error: string };

function safeCronError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown cron failure";
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

interface DependencyCronRunStore {
  start(input: { id: string; scheduledMinute: Date; startedAt: Date }): Promise<boolean>;
  complete(id: string, completedAt: Date, counts: DependencyCronRunCounts): Promise<void>;
  fail(id: string, completedAt: Date, errorMessage: string): Promise<void>;
}

export interface DependencyCronCoordinatorDeps {
  leases: DependencyLeaseStore;
  runs: DependencyCronRunStore;
  syncCatalog(): Promise<{ synced: boolean }>;
  loadDefaultRecipients(): Promise<string[]>;
  poll(defaultRecipients: string[]): Promise<{ sourcesDue: number; polled: number; notModified: number; failed: number }>;
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
    if (!(await deps.runs.start({ id: runId, scheduledMinute, startedAt }))) {
      return { status: "duplicate", runId } as const;
    }

    try {
      const syncResult = await deps.syncCatalog();
      const defaultRecipients = await deps.loadDefaultRecipients();
      const pollResult = await deps.poll(defaultRecipients);
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
    syncCatalog: () => syncCatalog(createSqlCatalogSyncStore(db), manifest),
    loadDefaultRecipients: async () => (await loadAcceptedConfig()).config.settings.defaultRecipients,
    poll: (defaultRecipients) => pollDueSources({
      store: pollerStore,
      persist: async (outcome, source, now) => {
        await persistSnapshot(persistStore, outcome, source, { now, defaultRecipients });
      },
    }),
    deliverOutbox: () => deliverPendingNotifications({
      db: queryExecutor,
      sender: createResendSender({ apiKey: process.env.RESEND_API_KEY ?? "", from: process.env.RESEND_FROM_EMAIL ?? "" }),
      appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
      log: (event) => console.info(JSON.stringify(event)),
    }),
  });
}
