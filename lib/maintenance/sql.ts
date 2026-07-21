import type { Database } from "@/lib/db/client"
import { createLiveCatalogDirectoryFetcher } from "@/lib/dependencies/catalog-revalidation"
import {
  createSqlCatalogReconcileStore,
  reconcileCatalog,
} from "@/lib/dependencies/catalog-sync"
import { reconcileStaleClaims } from "@/lib/notifications/sql"
import {
  type GovernorMode,
  retentionFor,
  STORAGE_BUDGET_BYTES,
} from "@/lib/storage/governor"
import {
  COMPACT_15_MINUTE_SQL,
  FILL_SCHEDULER_GAPS_SQL,
  MEASURE_USAGE_SQL,
  PROMOTE_ROLLUP_SQL,
  type UsageModeRow,
} from "@/lib/storage/sql"
import type { MaintenanceStore } from "./coordinator"

export type QueryFn = <T>(
  text: string,
  values: readonly unknown[]
) => Promise<readonly T[]>

export interface QueryExecutor {
  query: <T>(text: string, values: readonly unknown[]) => Promise<readonly T[]>
  /**
   * Optional: run work on one connection with transaction-local
   * statement_timeout so a long SQL step cannot outlive its maintenance
   * budget. When absent, callers fall back to plain query.
   */
  withStatementTimeout?: <T>(
    timeoutMs: number,
    work: (query: QueryFn) => Promise<T>
  ) => Promise<T>
}

interface AffectedRow {
  affected: number
}

const affected = (rows: readonly AffectedRow[]) => rows[0]?.affected ?? 0
const count = (rows: readonly unknown[]) => rows.length

/**
 * Runs a query, applying transaction-local statement_timeout when the executor
 * supports it and a positive remaining budget is provided.
 */
async function queryWithBudget<T>(
  db: QueryExecutor,
  remainingMs: number | undefined,
  text: string,
  values: readonly unknown[]
): Promise<readonly T[]> {
  if (
    remainingMs === undefined ||
    !Number.isFinite(remainingMs) ||
    remainingMs <= 0 ||
    typeof db.withStatementTimeout !== "function"
  ) {
    return db.query<T>(text, values)
  }
  const timeoutMs = Math.max(1, Math.floor(remainingMs))
  return db.withStatementTimeout(timeoutMs, (query) => query<T>(text, values))
}

const LATEST_GOVERNOR_MODE_SQL = `select governor_mode from database_usage_snapshots
order by captured_at desc limit 1`

const SCHEDULER_COVERAGE_START_SQL = `select coalesce(
  (select max(bucket_start + case resolution when '15m' then interval '15 minutes'
    when 'hour' then interval '1 hour' else interval '1 day' end) from metric_rollups),
  greatest((select min(scheduled_minute) from check_batches), $1::timestamptz - interval '48 hours'),
  $1::timestamptz - interval '48 hours'
) coverage_start`

const RECONCILE_CRON_SQL = `with changed as (
  update cron_runs set status = 'failed', completed_at = $1,
  error_message = 'Stale running cron reconciled' where status = 'running' and started_at < $2 returning 1
)
select count(*)::int as affected from changed`
const DELETE_CHECKS_SQL = `with doomed as (select id from check_results where created_at < $1 order by created_at, id limit $2),
deleted as (
  delete from check_results using doomed where check_results.id = doomed.id returning 1
)
select count(*)::int as affected from deleted`
const DELETE_SENT_SQL = `with doomed as (select id from notification_outbox where status = 'sent' and sent_at < $1 order by sent_at, id limit $2),
deleted as (
  delete from notification_outbox using doomed where notification_outbox.id = doomed.id returning 1
)
select count(*)::int as affected from deleted`
const DELETE_CRON_SQL = `with doomed as (select id from cron_runs where started_at < $1 order by started_at, id limit $2),
deleted as (
  delete from cron_runs using doomed where cron_runs.id = doomed.id returning 1
)
select count(*)::int as affected from deleted`
const EXPIRE_APPROVALS_SQL = `with doomed as (select id from config_change_approvals where (expires_at < $1 and consumed_at is null) or consumed_at < $2 order by created_at, id limit $3),
deleted as (
  delete from config_change_approvals using doomed where config_change_approvals.id = doomed.id returning 1
)
select count(*)::int as affected from deleted`
const EXPIRE_IDEMPOTENCY_SQL = `with doomed as (select id from api_idempotency where expires_at < $1 order by expires_at, id limit $2),
deleted as (
  delete from api_idempotency using doomed where api_idempotency.id = doomed.id returning 1
)
select count(*)::int as affected from deleted`
const MARK_DEVICE_EXPIRED_SQL = `with elapsed as (select id from device_authorizations where state in ('pending', 'approved') and expires_at < $1 order by expires_at, id limit $2),
changed as (
  update device_authorizations set state = 'expired' from elapsed where device_authorizations.id = elapsed.id returning 1
)
select count(*)::int as affected from changed`
const DELETE_DEVICE_SQL = `with doomed as (select id from device_authorizations where state in ('expired', 'denied', 'consumed') and expires_at < $1 order by expires_at, id limit $2),
deleted as (
  delete from device_authorizations using doomed where device_authorizations.id = doomed.id returning 1
)
select count(*)::int as affected from deleted`
const EXPIRE_RATE_SQL = `with doomed as (select ctid from api_rate_limit_buckets where expires_at < $1 order by expires_at limit $2),
deleted as (
  delete from api_rate_limit_buckets using doomed where api_rate_limit_buckets.ctid = doomed.ctid returning 1
)
select count(*)::int as affected from deleted`
const RETAIN_SNAPSHOTS_SQL = `with doomed as (
  select id from monitoring_config_snapshots where status = 'rejected' and seen_at < $1
  union all
  select id from (select id, row_number() over (order by accepted_at desc, seen_at desc, id desc) position
    from monitoring_config_snapshots where status = 'accepted') accepted where position > $2
), batch as (select id from doomed limit $3),
deleted as (
  delete from monitoring_config_snapshots using batch where monitoring_config_snapshots.id = batch.id returning 1
)
select count(*)::int as affected from deleted`
const RETAIN_TELEMETRY_SQL = `with doomed as (
  select scheduled_minute from check_batches
  where scheduled_minute < $1
    and (not $2::boolean or failure_bitmap = decode(repeat('00', octet_length(failure_bitmap)), 'hex') or scheduled_minute < $8)
  order by scheduled_minute limit $3
), deleted_batches as (
  delete from check_batches using doomed where check_batches.scheduled_minute = doomed.scheduled_minute
  returning 1
), doomed_rollups as (
  select monitor_id, resolution, bucket_start from metric_rollups
  where (resolution = '15m' and bucket_start < $4
      and (not $9::boolean or not has_incident or bucket_start < $10))
     or (resolution = 'hour' and bucket_start < $5
      and ($6::boolean or not has_incident or bucket_start < $10))
     or (resolution = 'day' and bucket_start < $7)
  order by bucket_start limit $3
), deleted_rollups as (
  delete from metric_rollups using doomed_rollups
  where metric_rollups.monitor_id = doomed_rollups.monitor_id
    and metric_rollups.resolution = doomed_rollups.resolution
    and metric_rollups.bucket_start = doomed_rollups.bucket_start
  returning 1
)
select (select count(*)::int from deleted_batches) + (select count(*)::int from deleted_rollups) as affected`
const RETAIN_USAGE_SQL = `with ranked as (
  select captured_at,
    max(captured_at) over (partition by date_trunc('day', captured_at)) daily_point,
    max(captured_at) over (partition by date_trunc('month', captured_at)) monthly_point,
    max(captured_at) over () latest_point
  from database_usage_snapshots
), doomed as (
  select captured_at from ranked
  where captured_at <> latest_point and (
    (captured_at < $1::timestamptz - interval '90 days' and captured_at <> monthly_point)
    or (captured_at < $1::timestamptz - interval '1 day'
      and captured_at >= $1::timestamptz - interval '90 days'
      and captured_at <> daily_point)
  ) order by captured_at limit $2
), deleted as (
  delete from database_usage_snapshots using doomed
  where database_usage_snapshots.captured_at = doomed.captured_at returning 1
)
select count(*)::int as affected from deleted`
const RETAIN_EXCEPTIONS_SQL = `with doomed as (select id from monitor_exceptions where last_seen_at < $1::timestamptz - interval '2 years' order by last_seen_at limit $2),
deleted as (
  delete from monitor_exceptions using doomed where monitor_exceptions.id = doomed.id returning 1
)
select count(*)::int as affected from deleted`
const RETAIN_PAYLOADS_SQL = `with doomed as (select id from exception_payloads where expires_at < $1 order by expires_at limit $2),
deleted as (
  delete from exception_payloads using doomed where exception_payloads.id = doomed.id returning 1
)
select count(*)::int as affected from deleted`
const DELETE_ORPHAN_IMAGES_SQL = `with referenced as (
  select logo_light_image_id id from status_page_config where logo_light_image_id is not null
  union select logo_dark_image_id from status_page_config where logo_dark_image_id is not null
  union select favicon_image_id from status_page_config where favicon_image_id is not null
  union select avatar_image_id from admin_users where avatar_image_id is not null
), unreferenced as (
  select images.id, images.created_at,
    row_number() over (order by images.created_at desc, images.id desc) position
  from images where not exists (select 1 from referenced where referenced.id = images.id)
), doomed as (
  select id from unreferenced where created_at < $1 or position > $2
  order by created_at, id limit $3
)
delete from images using doomed where images.id = doomed.id returning images.id`

// Empties body_text on provider_incident_updates older than the cutoff and
// leaves state, timing, and the row itself intact so dependency detail
// timelines keep incident identity while only the two-year-old prose drops.
// The body_text <> '' guard keeps already-emptied rows out of the batch, so
// drainBatches sees a shrinking count and stops instead of rewriting the same
// rows forever.
const RETAIN_DEPENDENCY_INCIDENT_UPDATES_SQL = `with doomed as (
  select incident_id, external_update_id from provider_incident_updates
  where provider_created_at < $1 and body_text <> ''
  order by provider_created_at limit $2
),
pruned as (
  update provider_incident_updates set body_text = '' from doomed
  where provider_incident_updates.incident_id = doomed.incident_id
    and provider_incident_updates.external_update_id = doomed.external_update_id
  returning 1
)
select count(*)::int as affected from pruned`

// Compacts closed dependency_state_intervals older than the cutoff into one
// row per (dependency, day, state): a day with only a single interval for a
// state has nothing to merge and is left untouched. This is lossy across a
// same-day same-state gap (e.g. two separate OPERATIONAL stretches around a
// same-day OUTAGE become one OPERATIONAL span), an accepted trade for
// keeping two-year-old history at daily granularity per the storage
// contract, matching decision 10's "no new mode, no new table" note.
const COMPACT_DEPENDENCY_STATE_INTERVALS_SQL = `with candidates as (
  select id, dependency_id, state, date_trunc('day', started_at) as day, started_at, ended_at
  from dependency_state_intervals
  where ended_at is not null and ended_at < $1
), groups as (
  select dependency_id, day, state,
    min(started_at) as started_at, max(ended_at) as ended_at,
    array_agg(id) as ids, count(*) as row_count
  from candidates
  group by dependency_id, day, state
  having count(*) > 1
  limit $2
), deleted as (
  delete from dependency_state_intervals
  where id in (select unnest(ids) from groups)
  returning 1
), inserted as (
  insert into dependency_state_intervals (id, dependency_id, state, started_at, ended_at, source_observed_at)
  select gen_random_uuid()::text, dependency_id, state, started_at, ended_at, started_at
  from groups
  returning 1
)
select (select count(*)::int from deleted) as affected`

export function createSqlMaintenanceStore(
  db: QueryExecutor,
  drizzle?: Database
): MaintenanceStore {
  return {
    async reconcileStaleOutbox(now, remainingMs) {
      // Apply the same remaining-budget statement_timeout as other SQL steps
      // when the executor supports it. Falls back to an untimed path otherwise.
      if (
        remainingMs !== undefined &&
        Number.isFinite(remainingMs) &&
        remainingMs > 0 &&
        typeof db.withStatementTimeout === "function"
      ) {
        const timeoutMs = Math.max(1, Math.floor(remainingMs))
        return db.withStatementTimeout(timeoutMs, (query) =>
          reconcileStaleClaims({ query }, now)
        )
      }
      return reconcileStaleClaims(db, now)
    },
    async reconcileStaleCronRuns(now, remainingMs) {
      return affected(
        await queryWithBudget<AffectedRow>(
          db,
          remainingMs,
          RECONCILE_CRON_SQL,
          [now, new Date(now.getTime() - 5 * 60_000)]
        )
      )
    },
    async deleteRawChecks(cutoff, limit, remainingMs) {
      return affected(
        await queryWithBudget<AffectedRow>(db, remainingMs, DELETE_CHECKS_SQL, [
          cutoff,
          limit,
        ])
      )
    },
    async deleteSentNotifications(cutoff, limit, remainingMs) {
      return affected(
        await queryWithBudget<AffectedRow>(db, remainingMs, DELETE_SENT_SQL, [
          cutoff,
          limit,
        ])
      )
    },
    async expireConfigApprovals(now, consumedCutoff, limit, remainingMs) {
      return affected(
        await queryWithBudget<AffectedRow>(
          db,
          remainingMs,
          EXPIRE_APPROVALS_SQL,
          [now, consumedCutoff, limit]
        )
      )
    },
    async expireApiIdempotency(now, limit, remainingMs) {
      return affected(
        await queryWithBudget<AffectedRow>(
          db,
          remainingMs,
          EXPIRE_IDEMPOTENCY_SQL,
          [now, limit]
        )
      )
    },
    async markDeviceAuthorizationsExpired(now, limit, remainingMs) {
      return affected(
        await queryWithBudget<AffectedRow>(
          db,
          remainingMs,
          MARK_DEVICE_EXPIRED_SQL,
          [now, limit]
        )
      )
    },
    async deleteExpiredDeviceAuthorizations(
      retentionCutoff,
      limit,
      remainingMs
    ) {
      return affected(
        await queryWithBudget<AffectedRow>(db, remainingMs, DELETE_DEVICE_SQL, [
          retentionCutoff,
          limit,
        ])
      )
    },
    async expireRateLimitBuckets(now, limit, remainingMs) {
      return affected(
        await queryWithBudget<AffectedRow>(db, remainingMs, EXPIRE_RATE_SQL, [
          now,
          limit,
        ])
      )
    },
    async retainConfigSnapshots(cutoff, acceptedLimit, limit, remainingMs) {
      return affected(
        await queryWithBudget<AffectedRow>(
          db,
          remainingMs,
          RETAIN_SNAPSHOTS_SQL,
          [cutoff, acceptedLimit, limit]
        )
      )
    },
    async deleteOldCronRuns(cutoff, limit, remainingMs) {
      return affected(
        await queryWithBudget<AffectedRow>(db, remainingMs, DELETE_CRON_SQL, [
          cutoff,
          limit,
        ])
      )
    },
    async deleteOldRollups() {
      // daily_rollups is dropped. metric_rollups day retention runs through
      // enforceTelemetryRetention, so this ladder has nothing to delete.
      return 0
    },
    async compact15Minute(start, end, now, remainingMs) {
      return count(
        await queryWithBudget(db, remainingMs, COMPACT_15_MINUTE_SQL, [
          start,
          end,
          now,
        ])
      )
    },
    async fillSchedulerGaps(start, end, now, remainingMs) {
      return count(
        await queryWithBudget(db, remainingMs, FILL_SCHEDULER_GAPS_SQL, [
          start,
          end,
          now,
        ])
      )
    },
    async schedulerCoverageStart(now, remainingMs) {
      const rows = await queryWithBudget<{ coverage_start: Date }>(
        db,
        remainingMs,
        SCHEDULER_COVERAGE_START_SQL,
        [now]
      )
      return rows[0]?.coverage_start ?? new Date(now.getTime() - 48 * 3_600_000)
    },
    async promoteRollups(source, target, start, end, remainingMs) {
      return count(
        await queryWithBudget(db, remainingMs, PROMOTE_ROLLUP_SQL, [
          source,
          target,
          start,
          end,
        ])
      )
    },
    async measureAndSnapshotUsage(now, remainingMs) {
      const rows = await queryWithBudget<UsageModeRow>(
        db,
        remainingMs,
        MEASURE_USAGE_SQL,
        [now, STORAGE_BUDGET_BYTES, null, null, null]
      )
      return rows[0]?.governor_mode ?? "essential"
    },
    async readLatestGovernorMode() {
      const rows = await db.query<{ governor_mode: GovernorMode }>(
        LATEST_GOVERNOR_MODE_SQL,
        []
      )
      return rows[0]?.governor_mode ?? null
    },
    async enforceTelemetryRetention(now, mode, limit, remainingMs) {
      const policy = retentionFor(mode)
      const minuteCutoff = new Date(
        now.getTime() - policy.minuteHours * 3_600_000
      )
      const quarterCutoff = new Date(
        now.getTime() - policy.quarterHourDays * 86_400_000
      )
      const hourCutoff = new Date(
        now.getTime() - policy.hourlyDays * 86_400_000
      )
      const dayCutoff = new Date(now.getTime() - 730 * 86_400_000)
      return affected(
        await queryWithBudget<AffectedRow>(
          db,
          remainingMs,
          RETAIN_TELEMETRY_SQL,
          [
            minuteCutoff,
            mode === "shortened" || mode === "incident_only",
            limit,
            quarterCutoff,
            hourCutoff,
            mode === "essential",
            dayCutoff,
            new Date(now.getTime() - 7 * 86_400_000),
            mode === "shortened" || mode === "incident_only",
            new Date(now.getTime() - 90 * 86_400_000),
          ]
        )
      )
    },
    async retainUsageSnapshots(now, limit, remainingMs) {
      return affected(
        await queryWithBudget<AffectedRow>(db, remainingMs, RETAIN_USAGE_SQL, [
          now,
          limit,
        ])
      )
    },
    async retainExceptions(now, limit, remainingMs) {
      return affected(
        await queryWithBudget<AffectedRow>(
          db,
          remainingMs,
          RETAIN_EXCEPTIONS_SQL,
          [now, limit]
        )
      )
    },
    async retainExceptionPayloads(now, limit, remainingMs) {
      return affected(
        await queryWithBudget<AffectedRow>(
          db,
          remainingMs,
          RETAIN_PAYLOADS_SQL,
          [now, limit]
        )
      )
    },
    async deleteOrphanImages(cutoff, keepNewest, limit, remainingMs) {
      return count(
        await queryWithBudget(db, remainingMs, DELETE_ORPHAN_IMAGES_SQL, [
          cutoff,
          keepNewest,
          limit,
        ])
      )
    },
    async reconcileDependencyCatalog(now, deadlineAtMs) {
      if (!drizzle) {
        return { checkedSources: 0, disabledPresets: 0 }
      }
      const summary = await reconcileCatalog({
        store: createSqlCatalogReconcileStore(drizzle),
        fetchCatalogDirectory: createLiveCatalogDirectoryFetcher(),
        now: () => now,
        deadlineAtMs,
      })
      return {
        checkedSources: summary.checkedSources,
        disabledPresets: summary.disabledPresets.length,
      }
    },
    async retainDependencyIncidentUpdates(cutoff, limit, remainingMs) {
      return affected(
        await queryWithBudget<AffectedRow>(
          db,
          remainingMs,
          RETAIN_DEPENDENCY_INCIDENT_UPDATES_SQL,
          [cutoff, limit]
        )
      )
    },
    async compactDependencyStateIntervals(cutoff, limit, remainingMs) {
      return affected(
        await queryWithBudget<AffectedRow>(
          db,
          remainingMs,
          COMPACT_DEPENDENCY_STATE_INTERVALS_SQL,
          [cutoff, limit]
        )
      )
    },
  }
}
