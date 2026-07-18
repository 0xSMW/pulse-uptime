import type { GovernorMode } from "./governor";

export const FILL_SCHEDULER_GAPS_SQL = `
with coverage as (
  select max(bucket_start) + interval '15 minutes' covered_until
  from metric_rollups
  where resolution = '15m'
), accepted_start as (
  select min(accepted_at) accepted_at from monitoring_config_snapshots where status = 'accepted'
), scan as (
  select greatest(
    $1::timestamptz,
    coalesce(coverage.covered_until, accepted_start.accepted_at, $2::timestamptz)
  ) scan_start
  from coverage cross join accepted_start
), missing as (
  select minute.scheduled_minute, config.config_version,
    array_agg(monitor.value->>'id' order by monitor.value->>'id') monitor_ids,
    array_agg((monitor.value->>'intervalMinutes')::integer order by monitor.value->>'id') intervals
  from scan
  cross join lateral generate_series(date_trunc('minute', scan.scan_start), date_trunc('minute', $2::timestamptz) - interval '1 minute', interval '1 minute') minute(scheduled_minute)
  cross join lateral (select config_version, config_json from monitoring_config_snapshots
    where status = 'accepted' and accepted_at <= minute.scheduled_minute
    order by accepted_at desc, seen_at desc limit 1) config
  cross join lateral jsonb_array_elements(config.config_json->'monitors') monitor(value)
  left join check_batches existing on existing.scheduled_minute = minute.scheduled_minute
  where existing.scheduled_minute is null and (monitor.value->>'enabled')::boolean
  group by minute.scheduled_minute, config.config_version
), inserted as (
  insert into check_batches (
    scheduled_minute, encoding_version, config_version, monitor_ids,
    expected_bitmap, completed_bitmap, failure_bitmap, latency_values,
    scheduler_started_at, scheduler_completed_at, created_at
  )
  select scheduled_minute, 1, config_version, monitor_ids,
    bitmap.expected_bitmap,
    decode(repeat('00', ceil(cardinality(monitor_ids) / 8.0)::integer), 'hex'),
    decode(repeat('00', ceil(cardinality(monitor_ids) / 8.0)::integer), 'hex'),
    decode(repeat('ff', cardinality(monitor_ids) * 4), 'hex'),
    scheduled_minute, null, $3
  from missing cross join lateral (
    select decode(string_agg(lpad(to_hex(expected_byte), 2, '0'), '' order by byte_position), 'hex') expected_bitmap
    from (
      select ((position - 1) / 8)::integer byte_position,
        sum(case when floor(extract(epoch from missing.scheduled_minute) / 60)::bigint % interval = 0
          then (1 << (((position - 1) % 8)::integer)) else 0 end)::integer expected_byte
      from unnest(missing.intervals) with ordinality cadence(interval, position)
      group by ((position - 1) / 8)::integer
    ) bytes
  ) bitmap
  on conflict (scheduled_minute) do nothing
  returning scheduled_minute, monitor_ids, expected_bitmap
), gap_events as (
  select inserted.scheduled_minute, monitor_id
  from inserted cross join lateral unnest(inserted.monitor_ids) with ordinality as monitors(monitor_id, position)
  where ((get_byte(inserted.expected_bitmap, ((position - 1) / 8)::integer) >> (((position - 1) % 8)::integer)) & 1) = 1
)
insert into monitor_exceptions (
  id, monitor_id, event_type, error_code, identity_hash,
  first_seen_at, last_seen_at, occurrence_count
)
select md5('scheduler_gap/' || monitor_id || '/' || scheduled_minute::text)::uuid,
  monitor_id, 'scheduler_gap', 'SCHEDULER_GAP', decode(md5('scheduler_gap/' || monitor_id || '/' || scheduled_minute::text), 'hex'),
  scheduled_minute, scheduled_minute, 1
from gap_events on conflict do nothing
`;

export const COMPACT_15_MINUTE_SQL = `
with minute_slots as (
  select batch.scheduled_minute, ids.monitor_id, ids.position,
    ((get_byte(batch.expected_bitmap, ((ids.position - 1) / 8)::integer) >> (((ids.position - 1) % 8)::integer)) & 1) expected,
    ((get_byte(batch.completed_bitmap, ((ids.position - 1) / 8)::integer) >> (((ids.position - 1) % 8)::integer)) & 1) completed,
    ((get_byte(batch.failure_bitmap, ((ids.position - 1) / 8)::integer) >> (((ids.position - 1) % 8)::integer)) & 1) failed,
    case when ((get_byte(batch.completed_bitmap, ((ids.position - 1) / 8)::integer) >> (((ids.position - 1) % 8)::integer)) & 1) = 1 then
      ((get_byte(batch.latency_values, ((ids.position - 1) * 4)::integer)::bigint << 24)
      + (get_byte(batch.latency_values, ((ids.position - 1) * 4 + 1)::integer)::bigint << 16)
      + (get_byte(batch.latency_values, ((ids.position - 1) * 4 + 2)::integer)::bigint << 8)
      + get_byte(batch.latency_values, ((ids.position - 1) * 4 + 3)::integer)::bigint)::integer
    else null end latency_ms
  from check_batches batch
  cross join lateral unnest(batch.monitor_ids) with ordinality ids(monitor_id, position)
  where batch.scheduled_minute >= $1
    and batch.scheduled_minute < date_bin(interval '15 minutes', $2::timestamptz, timestamptz '2000-01-01')
), buckets as (
  select slots.monitor_id, date_bin(interval '15 minutes', slots.scheduled_minute, timestamptz '2000-01-01') bucket_start,
    count(*)::integer expected_checks,
    count(*) filter (where completed = 1)::integer completed_checks,
    count(*) filter (where completed = 1 and failed = 0)::integer successful_checks,
    count(*) filter (where failed = 1)::integer failed_checks,
    count(*) filter (where completed = 0)::integer unknown_checks,
    (count(*) filter (where incident.id is not null) * 60)::integer downtime_seconds,
    (count(*) filter (where completed = 0) * 60)::integer unknown_seconds,
    count(slots.latency_ms) filter (where completed = 1)::integer latency_count,
    coalesce(sum(slots.latency_ms) filter (where completed = 1), 0)::bigint latency_sum_ms,
    min(slots.latency_ms) filter (where completed = 1)::integer latency_min_ms,
    max(slots.latency_ms) filter (where completed = 1)::integer latency_max_ms,
    array[
      count(slots.latency_ms) filter (where slots.latency_ms <= 100),
      count(slots.latency_ms) filter (where slots.latency_ms > 100 and slots.latency_ms <= 250),
      count(slots.latency_ms) filter (where slots.latency_ms > 250 and slots.latency_ms <= 500),
      count(slots.latency_ms) filter (where slots.latency_ms > 500 and slots.latency_ms <= 1000),
      count(slots.latency_ms) filter (where slots.latency_ms > 1000 and slots.latency_ms <= 2500),
      count(slots.latency_ms) filter (where slots.latency_ms > 2500 and slots.latency_ms <= 5000),
      count(slots.latency_ms) filter (where slots.latency_ms > 5000 and slots.latency_ms <= 10000),
      count(slots.latency_ms) filter (where slots.latency_ms > 10000)
    ]::integer[] latency_histogram,
    bool_or(incident.id is not null) has_incident
  from minute_slots slots
  left join incidents incident on incident.monitor_id = slots.monitor_id
    and incident.opened_at < slots.scheduled_minute + interval '1 minute'
    and coalesce(incident.resolved_at, 'infinity') > slots.scheduled_minute
  where slots.expected = 1
  group by slots.monitor_id, date_bin(interval '15 minutes', slots.scheduled_minute, timestamptz '2000-01-01')
)
insert into metric_rollups (
  monitor_id, resolution, bucket_start, expected_checks, completed_checks,
  successful_checks, failed_checks, unknown_checks, downtime_seconds, unknown_seconds,
  latency_count, latency_sum_ms, latency_min_ms, latency_max_ms, latency_histogram,
  histogram_version, has_incident, compacted_at
)
select monitor_id, '15m', bucket_start, expected_checks, completed_checks,
  successful_checks, failed_checks, unknown_checks, downtime_seconds, unknown_seconds,
  latency_count, latency_sum_ms, latency_min_ms, latency_max_ms, latency_histogram,
  1, has_incident, $3
from buckets
on conflict (monitor_id, resolution, bucket_start) do update set
  expected_checks = excluded.expected_checks, completed_checks = excluded.completed_checks,
  successful_checks = excluded.successful_checks, failed_checks = excluded.failed_checks,
  unknown_checks = excluded.unknown_checks, downtime_seconds = excluded.downtime_seconds,
  unknown_seconds = excluded.unknown_seconds, latency_count = excluded.latency_count,
  latency_sum_ms = excluded.latency_sum_ms, latency_min_ms = excluded.latency_min_ms,
  latency_max_ms = excluded.latency_max_ms, latency_histogram = excluded.latency_histogram,
  histogram_version = excluded.histogram_version, has_incident = excluded.has_incident,
  compacted_at = excluded.compacted_at
`;

export const PROMOTE_ROLLUP_SQL = `
insert into metric_rollups (
  monitor_id, resolution, bucket_start, expected_checks, completed_checks,
  successful_checks, failed_checks, unknown_checks, downtime_seconds, unknown_seconds,
  latency_count, latency_sum_ms, latency_min_ms, latency_max_ms, latency_histogram,
  histogram_version, has_incident, compacted_at
)
select monitor_id, $2,
  case when $2 = 'hour' then date_trunc('hour', bucket_start at time zone 'UTC') at time zone 'UTC'
    else date_trunc('day', bucket_start at time zone 'UTC') at time zone 'UTC' end,
  sum(expected_checks)::integer, sum(completed_checks)::integer, sum(successful_checks)::integer,
  sum(failed_checks)::integer, sum(unknown_checks)::integer, sum(downtime_seconds)::integer,
  sum(unknown_seconds)::integer, sum(latency_count)::integer, sum(latency_sum_ms)::bigint,
  min(latency_min_ms), max(latency_max_ms),
  array[sum(latency_histogram[1]), sum(latency_histogram[2]), sum(latency_histogram[3]), sum(latency_histogram[4]),
    sum(latency_histogram[5]), sum(latency_histogram[6]), sum(latency_histogram[7]), sum(latency_histogram[8])]::integer[],
  1, bool_or(has_incident), $4
from metric_rollups
where resolution = $1
  and bucket_start >= case when $2 = 'hour' then date_trunc('hour', $3::timestamptz at time zone 'UTC') at time zone 'UTC'
    else date_trunc('day', $3::timestamptz at time zone 'UTC') at time zone 'UTC' end
  and bucket_start < case when $2 = 'hour' then date_trunc('hour', $4::timestamptz at time zone 'UTC') at time zone 'UTC'
    else date_trunc('day', $4::timestamptz at time zone 'UTC') at time zone 'UTC' end
group by monitor_id, case when $2 = 'hour' then date_trunc('hour', bucket_start at time zone 'UTC') at time zone 'UTC'
  else date_trunc('day', bucket_start at time zone 'UTC') at time zone 'UTC' end
on conflict (monitor_id, resolution, bucket_start) do update set
  expected_checks = excluded.expected_checks, completed_checks = excluded.completed_checks,
  successful_checks = excluded.successful_checks, failed_checks = excluded.failed_checks,
  unknown_checks = excluded.unknown_checks, downtime_seconds = excluded.downtime_seconds,
  unknown_seconds = excluded.unknown_seconds, latency_count = excluded.latency_count,
  latency_sum_ms = excluded.latency_sum_ms, latency_min_ms = excluded.latency_min_ms,
  latency_max_ms = excluded.latency_max_ms, latency_histogram = excluded.latency_histogram,
  histogram_version = excluded.histogram_version, has_incident = excluded.has_incident,
  compacted_at = excluded.compacted_at
`;

export const MEASURE_USAGE_SQL = `
with relations as (
  select c.relname,
    pg_relation_size(c.oid)::bigint table_bytes,
    pg_indexes_size(c.oid)::bigint index_bytes,
    pg_total_relation_size(c.oid)::bigint total_bytes
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = current_schema() and c.relkind = 'r'
), totals as (
  select coalesce(sum(total_bytes), 0)::bigint storage_bytes,
    coalesce(sum(index_bytes), 0)::bigint index_bytes,
    jsonb_build_object(
      'recentCheckBatches', coalesce(sum(table_bytes) filter (where relname = 'check_batches'), 0),
      'rollups', coalesce(sum(table_bytes) filter (where relname in ('metric_rollups','daily_rollups')), 0),
      'exceptions', coalesce(sum(table_bytes) filter (where relname in ('monitor_exceptions','exception_payloads')), 0),
      'incidents', coalesce(sum(table_bytes) filter (where relname in ('incidents','incident_events')), 0),
      'coreData', coalesce(sum(table_bytes) filter (where relname in ('monitor_registry','monitor_state','monitoring_config_snapshots','admin_users')), 0),
      'operations', coalesce(sum(table_bytes) filter (where relname in ('cron_runs','notification_outbox','atomic_minute_commits')), 0),
      'indexes', coalesce(sum(index_bytes), 0)
    ) category_bytes
  from relations
), growth as (
  select greatest(0, (totals.storage_bytes - old.storage_bytes) * 30 /
    greatest(1, extract(epoch from ($1::timestamptz - old.captured_at)) / 86400))::bigint growth_bytes
  from totals left join lateral (
    select captured_at, storage_bytes from database_usage_snapshots
    where captured_at >= $1::timestamptz - interval '30 days' order by captured_at limit 1
  ) old on true
), measured as (
  select totals.*, (totals.storage_bytes + coalesce(growth.growth_bytes, 0))::bigint projected_bytes
  from totals cross join growth
), classified as (
  select *, case
    when projected_bytes * 100 < $2::bigint * 60 then 'full'
    when projected_bytes * 100 < $2::bigint * 75 then 'compact_early'
    when projected_bytes * 100 < $2::bigint * 85 then 'shortened'
    when projected_bytes * 100 <= $2::bigint * 95 then 'incident_only'
    else 'essential' end governor_mode
  from measured
), coverage as (
  select case when count(*) = 0 then null else
    round(1.0 * count(*) filter (where status = 'completed') / count(*), 4) end scheduler_coverage
  from cron_runs where job_name = 'monitor-check' and scheduled_minute >= $1::timestamptz - interval '24 hours'
)
insert into database_usage_snapshots (
  captured_at, storage_bytes, index_bytes, category_bytes, history_bytes,
  monthly_transfer_bytes, projected_30_day_bytes, governor_mode, last_compaction_at,
  scheduler_coverage, provider_metrics_captured_at
)
select $1::timestamptz, storage_bytes, index_bytes,
  category_bytes || jsonb_build_object('other', greatest(0, coalesce($3::bigint, storage_bytes) - storage_bytes)),
  case when $3::bigint is null then null else greatest(0, $3::bigint - storage_bytes) end,
  $4::bigint, projected_bytes, governor_mode,
  (select max(compacted_at) from metric_rollups), scheduler_coverage, $5::timestamptz
from classified cross join coverage
on conflict (captured_at) do update set
  storage_bytes = excluded.storage_bytes, index_bytes = excluded.index_bytes,
  category_bytes = excluded.category_bytes, history_bytes = excluded.history_bytes,
  monthly_transfer_bytes = excluded.monthly_transfer_bytes,
  projected_30_day_bytes = excluded.projected_30_day_bytes,
  governor_mode = excluded.governor_mode, last_compaction_at = excluded.last_compaction_at,
  scheduler_coverage = excluded.scheduler_coverage,
  provider_metrics_captured_at = excluded.provider_metrics_captured_at
returning governor_mode
`;

export type UsageModeRow = { governor_mode: GovernorMode };
