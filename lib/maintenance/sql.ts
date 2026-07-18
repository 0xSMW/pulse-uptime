import type { MaintenanceStore } from "./coordinator";
import { reconcileStaleClaims } from "@/lib/notifications/sql";

export interface QueryExecutor {
  query<T>(text: string, values: readonly unknown[]): Promise<readonly T[]>;
}

const count = (rows: readonly unknown[]) => rows.length;

export const ROLLUP_DAY_SQL = `
insert into daily_rollups (
  monitor_id, day, total_checks, successful_checks, failed_checks,
  uptime_percentage, average_latency_ms, p50_latency_ms, p95_latency_ms, incident_seconds
)
select registry.id, $1::date,
  coalesce(checks.total_checks, 0), coalesce(checks.successful_checks, 0), coalesce(checks.failed_checks, 0),
  case when coalesce(checks.total_checks, 0) = 0 then null
       else round(100.0 * checks.successful_checks / checks.total_checks, 4) end,
  checks.average_latency_ms, checks.p50_latency_ms, checks.p95_latency_ms,
  coalesce(incident_time.incident_seconds, 0)
from monitor_registry registry
left join lateral (
  select count(*)::integer total_checks,
    count(*) filter (where successful)::integer successful_checks,
    count(*) filter (where not successful)::integer failed_checks,
    round(avg(latency_ms))::integer average_latency_ms,
    round(percentile_cont(0.5) within group (order by latency_ms))::integer p50_latency_ms,
    round(percentile_cont(0.95) within group (order by latency_ms))::integer p95_latency_ms
  from check_results
  where monitor_id = registry.id and checked_at >= $1::date and checked_at < $1::date + interval '1 day'
) checks on true
left join lateral (
  select round(coalesce(sum(extract(epoch from (
    least(coalesce(resolved_at, $1::date + interval '1 day'), $1::date + interval '1 day') -
    greatest(opened_at, $1::date)
  ))), 0))::integer incident_seconds
  from incidents
  where monitor_id = registry.id
    and opened_at < $1::date + interval '1 day'
    and coalesce(resolved_at, $2) > $1::date
) incident_time on true
where registry.first_seen_at < $1::date + interval '1 day'
  and (registry.archived_at is null or registry.archived_at >= $1::date)
on conflict (monitor_id, day) do update set
  total_checks = excluded.total_checks,
  successful_checks = excluded.successful_checks,
  failed_checks = excluded.failed_checks,
  uptime_percentage = excluded.uptime_percentage,
  average_latency_ms = excluded.average_latency_ms,
  p50_latency_ms = excluded.p50_latency_ms,
  p95_latency_ms = excluded.p95_latency_ms,
  incident_seconds = excluded.incident_seconds
returning monitor_id
`;

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

export function createSqlMaintenanceStore(db: QueryExecutor): MaintenanceStore {
  return {
    async reconcileStaleOutbox(now) {
      return reconcileStaleClaims(db, now);
    },
    async reconcileStaleCronRuns(now) {
      return count(await db.query(RECONCILE_CRON_SQL, [now, new Date(now.getTime() - 5 * 60_000)]));
    },
    async upsertDailyRollup(day, now) {
      return count(await db.query(ROLLUP_DAY_SQL, [day, now]));
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
  };
}
