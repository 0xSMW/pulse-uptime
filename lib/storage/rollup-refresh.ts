import { COMPACT_15_MINUTE_SQL, PROMOTE_ROLLUP_SQL } from "./sql"

export interface RollupRefreshExecutor {
  query: <T>(text: string, values: readonly unknown[]) => Promise<readonly T[]>
}

export const ROLLUP_REFRESH_MIN_LOOKBACK_MS = 2 * 3_600_000
export const ROLLUP_REFRESH_MAX_LOOKBACK_MS = 48 * 3_600_000

export const ROLLUP_COVERED_UNTIL_SQL = `select max(bucket_start) + interval '15 minutes' covered_until
from metric_rollups where resolution = '15m'`

export function completesQuarterHourBucket(scheduledMinute: Date): boolean {
  return (Math.floor(scheduledMinute.getTime() / 60_000) + 1) % 15 === 0
}

export async function refreshRecentRollups(
  db: RollupRefreshExecutor,
  scheduledMinute: Date,
  now: Date
): Promise<void> {
  // End one minute past the just-persisted minute so date_bin includes the
  // quarter-hour bucket this minute completed.
  const end = new Date(scheduledMinute.getTime() + 60_000)
  // Reach back to wherever compaction last stopped so gaps (deploys, cron
  // outages) heal on the next boundary, bounded to keep the scan cheap.
  const coverage = await db.query<{ covered_until: Date | string | null }>(
    ROLLUP_COVERED_UNTIL_SQL,
    []
  )
  const coveredUntil = coverage[0]?.covered_until
    ? new Date(coverage[0].covered_until).getTime()
    : 0
  const start = new Date(
    Math.max(
      end.getTime() - ROLLUP_REFRESH_MAX_LOOKBACK_MS,
      Math.min(coveredUntil, end.getTime() - ROLLUP_REFRESH_MIN_LOOKBACK_MS)
    )
  )
  await db.query(COMPACT_15_MINUTE_SQL, [start, end, now])
  await db.query(PROMOTE_ROLLUP_SQL, ["15m", "hour", start, end])
  await db.query(PROMOTE_ROLLUP_SQL, ["hour", "day", start, end])
}
