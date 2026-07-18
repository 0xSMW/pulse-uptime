import type { MaintenanceStore } from "./coordinator";
import { reconcileStaleClaims } from "@/lib/notifications/sql";
import { retentionFor, STORAGE_BUDGET_BYTES } from "@/lib/storage/governor";
import {
  COMPACT_15_MINUTE_SQL,
  FILL_SCHEDULER_GAPS_SQL,
  MEASURE_USAGE_SQL,
  PROMOTE_ROLLUP_SQL,
  type UsageModeRow,
} from "@/lib/storage/sql";

export interface QueryExecutor {
  query<T>(text: string, values: readonly unknown[]): Promise<readonly T[]>;
}

const count = (rows: readonly unknown[]) => rows.length;

const SCHEDULER_COVERAGE_START_SQL = `select coalesce(
  (select max(bucket_start + case resolution when '15m' then interval '15 minutes'
    when 'hour' then interval '1 hour' else interval '1 day' end) from metric_rollups),
  greatest((select min(scheduled_minute) from check_batches), $1::timestamptz - interval '48 hours'),
  $1::timestamptz - interval '48 hours'
) coverage_start`;

const RECONCILE_CRON_SQL = `update cron_runs set status = 'failed', completed_at = $1,
error_message = 'Stale running cron reconciled' where status = 'running' and started_at < $2 returning id`;
const DELETE_CHECKS_SQL = `with doomed as (select id from check_results where created_at < $1 order by created_at, id limit $2)
delete from check_results using doomed where check_results.id = doomed.id returning check_results.id`;
const DELETE_SENT_SQL = `with doomed as (select id from notification_outbox where status = 'sent' and sent_at < $1 order by sent_at, id limit $2)
delete from notification_outbox using doomed where notification_outbox.id = doomed.id returning notification_outbox.id`;
const DELETE_CRON_SQL = `with doomed as (select id from cron_runs where started_at < $1 order by started_at, id limit $2)
delete from cron_runs using doomed where cron_runs.id = doomed.id returning cron_runs.id`;
const DELETE_ROLLUPS_SQL = `with doomed as (select monitor_id, day from daily_rollups where day < $1::date order by day, monitor_id limit $2)
delete from daily_rollups using doomed where daily_rollups.monitor_id = doomed.monitor_id and daily_rollups.day = doomed.day returning daily_rollups.monitor_id`;
const EXPIRE_APPROVALS_SQL = `with doomed as (select id from config_change_approvals where (expires_at < $1 and consumed_at is null) or consumed_at < $2 order by created_at, id limit $3)
delete from config_change_approvals using doomed where config_change_approvals.id = doomed.id returning config_change_approvals.id`;
const EXPIRE_IDEMPOTENCY_SQL = `with doomed as (select id from api_idempotency where expires_at < $1 order by expires_at, id limit $2)
delete from api_idempotency using doomed where api_idempotency.id = doomed.id returning api_idempotency.id`;
const MARK_DEVICE_EXPIRED_SQL = `with elapsed as (select id from device_authorizations where state in ('pending', 'approved') and expires_at < $1 order by expires_at, id limit $2)
update device_authorizations set state = 'expired' from elapsed where device_authorizations.id = elapsed.id returning device_authorizations.id`;
const DELETE_DEVICE_SQL = `with doomed as (select id from device_authorizations where state in ('expired', 'denied', 'consumed') and expires_at < $1 order by expires_at, id limit $2)
delete from device_authorizations using doomed where device_authorizations.id = doomed.id returning device_authorizations.id`;
const EXPIRE_RATE_SQL = `with doomed as (select ctid from api_rate_limit_buckets where expires_at < $1 order by expires_at limit $2)
delete from api_rate_limit_buckets using doomed where api_rate_limit_buckets.ctid = doomed.ctid returning api_rate_limit_buckets.principal_key`;
const RETAIN_SNAPSHOTS_SQL = `with doomed as (
  select id from monitoring_config_snapshots where status = 'rejected' and seen_at < $1
  union all
  select id from (select id, row_number() over (order by accepted_at desc, seen_at desc, id desc) position
    from monitoring_config_snapshots where status = 'accepted') accepted where position > $2
), batch as (select id from doomed limit $3)
delete from monitoring_config_snapshots using batch where monitoring_config_snapshots.id = batch.id returning monitoring_config_snapshots.id`;
const RETAIN_TELEMETRY_SQL = `with doomed as (
  select scheduled_minute from check_batches
  where scheduled_minute < $1
    and (not $2::boolean or failure_bitmap = decode(repeat('00', octet_length(failure_bitmap)), 'hex') or scheduled_minute < $8)
  order by scheduled_minute limit $3
), deleted_batches as (
  delete from check_batches using doomed where check_batches.scheduled_minute = doomed.scheduled_minute
  returning check_batches.scheduled_minute
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
  returning metric_rollups.bucket_start
)
select scheduled_minute::text from deleted_batches union all select bucket_start::text from deleted_rollups`;
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
)
delete from database_usage_snapshots using doomed
where database_usage_snapshots.captured_at = doomed.captured_at returning database_usage_snapshots.captured_at`;
const RETAIN_EXCEPTIONS_SQL = `with doomed as (select id from monitor_exceptions where last_seen_at < $1::timestamptz - interval '2 years' order by last_seen_at limit $2)
delete from monitor_exceptions using doomed where monitor_exceptions.id = doomed.id returning monitor_exceptions.id`;
const RETAIN_PAYLOADS_SQL = `with doomed as (select id from exception_payloads where expires_at < $1 order by expires_at limit $2)
delete from exception_payloads using doomed where exception_payloads.id = doomed.id returning exception_payloads.id`;

export function createSqlMaintenanceStore(db: QueryExecutor): MaintenanceStore {
  return {
    async reconcileStaleOutbox(now) {
      return reconcileStaleClaims(db, now);
    },
    async reconcileStaleCronRuns(now) {
      return count(await db.query(RECONCILE_CRON_SQL, [now, new Date(now.getTime() - 5 * 60_000)]));
    },
    async deleteRawChecks(cutoff, limit) { return count(await db.query(DELETE_CHECKS_SQL, [cutoff, limit])); },
    async deleteSentNotifications(cutoff, limit) { return count(await db.query(DELETE_SENT_SQL, [cutoff, limit])); },
    async expireConfigApprovals(now, consumedCutoff, limit) {
      return count(await db.query(EXPIRE_APPROVALS_SQL, [now, consumedCutoff, limit]));
    },
    async expireApiIdempotency(now, limit) { return count(await db.query(EXPIRE_IDEMPOTENCY_SQL, [now, limit])); },
    async markDeviceAuthorizationsExpired(now, limit) {
      return count(await db.query(MARK_DEVICE_EXPIRED_SQL, [now, limit]));
    },
    async deleteExpiredDeviceAuthorizations(retentionCutoff, limit) {
      return count(await db.query(DELETE_DEVICE_SQL, [retentionCutoff, limit]));
    },
    async expireRateLimitBuckets(now, limit) { return count(await db.query(EXPIRE_RATE_SQL, [now, limit])); },
    async retainConfigSnapshots(cutoff, acceptedLimit, limit) {
      return count(await db.query(RETAIN_SNAPSHOTS_SQL, [cutoff, acceptedLimit, limit]));
    },
    async deleteOldCronRuns(cutoff, limit) { return count(await db.query(DELETE_CRON_SQL, [cutoff, limit])); },
    async deleteOldRollups(dayCutoff, limit) { return count(await db.query(DELETE_ROLLUPS_SQL, [dayCutoff, limit])); },
    async compact15Minute(start, end, now) {
      return count(await db.query(COMPACT_15_MINUTE_SQL, [start, end, now]));
    },
    async fillSchedulerGaps(start, end, now) {
      return count(await db.query(FILL_SCHEDULER_GAPS_SQL, [start, end, now]));
    },
    async schedulerCoverageStart(now) {
      const rows = await db.query<{ coverage_start: Date }>(SCHEDULER_COVERAGE_START_SQL, [now]);
      return rows[0]?.coverage_start ?? new Date(now.getTime() - 48 * 3_600_000);
    },
    async promoteRollups(source, target, start, end) {
      return count(await db.query(PROMOTE_ROLLUP_SQL, [source, target, start, end]));
    },
    async measureAndSnapshotUsage(now) {
      const rows = await db.query<UsageModeRow>(MEASURE_USAGE_SQL, [now, STORAGE_BUDGET_BYTES, null, null, null]);
      return rows[0]?.governor_mode ?? "essential";
    },
    async enforceTelemetryRetention(now, mode, limit) {
      const policy = retentionFor(mode);
      const minuteCutoff = new Date(now.getTime() - policy.minuteHours * 3_600_000);
      const quarterCutoff = new Date(now.getTime() - policy.quarterHourDays * 86_400_000);
      const hourCutoff = new Date(now.getTime() - policy.hourlyDays * 86_400_000);
      const dayCutoff = new Date(now.getTime() - 730 * 86_400_000);
      return count(await db.query(RETAIN_TELEMETRY_SQL, [
        minuteCutoff, mode === "shortened" || mode === "incident_only", limit, quarterCutoff, hourCutoff,
        mode === "essential", dayCutoff, new Date(now.getTime() - 7 * 86_400_000),
        mode === "shortened" || mode === "incident_only", new Date(now.getTime() - 90 * 86_400_000),
      ]));
    },
    async retainUsageSnapshots(now, limit) { return count(await db.query(RETAIN_USAGE_SQL, [now, limit])); },
    async retainExceptions(now, limit) { return count(await db.query(RETAIN_EXCEPTIONS_SQL, [now, limit])); },
    async retainExceptionPayloads(now, limit) { return count(await db.query(RETAIN_PAYLOADS_SQL, [now, limit])); },
  };
}
