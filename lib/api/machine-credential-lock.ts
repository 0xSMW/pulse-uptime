import "server-only"

import { sql } from "drizzle-orm"

import type { DatabaseTransaction } from "@/lib/db/client"

const MACHINE_CREDENTIAL_LOCK_SQL = sql`select pg_advisory_xact_lock(hashtext('pulse:machine-credentials'))`

export async function lockMachineCredentialChanges(
  tx: DatabaseTransaction
): Promise<void> {
  await tx.execute(MACHINE_CREDENTIAL_LOCK_SQL)
}
