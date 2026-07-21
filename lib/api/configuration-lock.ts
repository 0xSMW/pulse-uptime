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
