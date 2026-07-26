import type { DatabaseHandle } from "@/lib/db/client"
import { notificationOutbox } from "@/lib/db/schema"
import type {
  DomainExpiryOutboxEnqueuer,
  DomainExpiryOutboxRow,
} from "@/lib/domain-health/alerts"

/**
 * Persists rows selected by the pure domain-expiry policy. Domain alerts have
 * no incident, monitor, or dependency subject, so those columns are omitted.
 * The unique idempotency key preserves the policy's alert cycle semantics.
 */
export async function enqueueDomainExpiryOutboxRows(
  db: DatabaseHandle,
  rows: readonly DomainExpiryOutboxRow[]
): Promise<number> {
  if (rows.length === 0) {
    return 0
  }

  const inserted = await db
    .insert(notificationOutbox)
    .values([...rows])
    .onConflictDoNothing({ target: notificationOutbox.idempotencyKey })
    .returning({ id: notificationOutbox.id })
  return inserted.length
}

/** Binds the persistence adapter for the pure domain-health alert policy. */
export function createDomainExpiryOutboxEnqueuer(
  db: DatabaseHandle
): DomainExpiryOutboxEnqueuer {
  return (rows) => enqueueDomainExpiryOutboxRows(db, rows)
}
