import type { QueryExecutor } from "@/lib/maintenance/sql";

import type { LeaseStore } from "./lease";
import type { CronRunStore } from "./run-record";

export const ACQUIRE_LEASE_SQL = `
insert into job_leases (name, owner_id, lease_until, updated_at)
values ($1, $2, clock_timestamp() + ($3 * interval '1 millisecond'), clock_timestamp())
on conflict (name) do update set owner_id = excluded.owner_id,
lease_until = excluded.lease_until, updated_at = excluded.updated_at
where job_leases.lease_until <= clock_timestamp()
returning name
`;

export function createSqlLeaseStore(db: QueryExecutor): LeaseStore {
  return {
    async acquire(name, ownerId, durationMs) {
      return (await db.query(ACQUIRE_LEASE_SQL, [name, ownerId, durationMs])).length === 1;
    },
    async release(name, ownerId) {
      await db.query("delete from job_leases where name = $1 and owner_id = $2 returning name", [name, ownerId]);
    },
  };
}

export function createSqlCronRunStore(db: QueryExecutor): CronRunStore {
  return {
    async start(input) {
      const rows = await db.query(`insert into cron_runs
(id, job_name, scheduled_minute, status, started_at, monitor_count, success_count, failure_count, skipped_count, release_id)
values ($1, $2, $3, 'running', $4, 0, 0, 0, 0, $5)
on conflict (job_name, scheduled_minute) do nothing returning id`, [
        input.id, input.jobName, input.scheduledMinute, input.startedAt, input.releaseId,
      ]);
      return rows.length === 1;
    },
    async complete(id, completedAt, counts) {
      await db.query(`update cron_runs set status = 'completed', completed_at = $2,
monitor_count = $3, success_count = $4, failure_count = $5, skipped_count = $6, error_message = null, error_detail = null
where id = $1 and status = 'running' returning id`, [
        id, completedAt, counts.monitorCount, counts.successCount, counts.failureCount, counts.skippedCount,
      ]);
    },
    async fail(id, completedAt, failure, counts = { monitorCount: 0, successCount: 0, failureCount: 0, skippedCount: 0 }) {
      await db.query(`update cron_runs set status = 'failed', completed_at = $2, error_message = $3,
error_detail = $8::jsonb,
monitor_count = $4, success_count = $5, failure_count = $6, skipped_count = $7
where id = $1 and status = 'running' returning id`, [
        id, completedAt, failure.message, counts.monitorCount, counts.successCount, counts.failureCount, counts.skippedCount,
        JSON.stringify(failure.capture),
      ]);
    },
  };
}
