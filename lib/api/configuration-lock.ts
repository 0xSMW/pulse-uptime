import { type SQL, sql } from "drizzle-orm"

/**
 * Fixed namespace for the monitoring-configuration advisory lock.
 * Callers must not invent alternate keys for the same critical section.
 */
export const CONFIGURATION_LOCK_KEY = "pulse:configuration"

/**
 * Any transaction-like handle that can run raw SQL. Kept structural so unit
 * tests and drizzle transactions both satisfy the contract without casting.
 */
export interface ConfigurationLockExecutor {
  execute: (query: SQL) => Promise<unknown>
}

/**
 * Transaction invariant for configuration acceptance:
 * Acquire lock → read accepted snapshot through same transaction → evaluate
 * desired config → consume matching approval → insert accepted/rejected
 * snapshot → synchronize registry → commit.
 *
 * External Edge Config I/O may occur before the lock to minimize lock time,
 * but every acceptance decision re-reads current database state after
 * acquiring the lock.
 *
 * Prefer this primitive inside an existing transaction (or savepoint) so
 * idempotent outer transactions can hold the lock without opening a second
 * top-level transaction.
 */
export async function lockConfiguration(
  tx: ConfigurationLockExecutor
): Promise<void> {
  // Bound parameter keeps the key single-sourced with CONFIGURATION_LOCK_KEY.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${CONFIGURATION_LOCK_KEY}))`
  )
}

/**
 * Read the database clock after the lock is held. Every acceptance writer
 * stamps its accepted snapshot from this one lock-serialized clock source, so
 * the later lock holder reads a non-earlier instant regardless of application
 * host clock skew. A durable commit spans more than the millisecond resolution
 * of a JavaScript Date, so the later committed snapshot sorts strictly newer and
 * the current-accepted reader returns the config the registry sync just wrote.
 *
 * The clock is read as epoch milliseconds because a raw execute bypasses the
 * column mappers and returns the timestamp as an unparsed string. The numeric
 * cast fixes the wire format to a plain decimal string that Number parses
 * exactly at millisecond granularity.
 */
export async function lockedNow(tx: ConfigurationLockExecutor): Promise<Date> {
  const rows = (await tx.execute(
    sql`select (extract(epoch from clock_timestamp()) * 1000)::numeric as epoch_ms`
  )) as Array<{ epoch_ms: string }>
  const [row] = rows
  if (!row) {
    throw new Error("clock_timestamp query returned no row")
  }
  return new Date(Number(row.epoch_ms))
}
