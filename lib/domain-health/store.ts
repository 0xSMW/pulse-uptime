import { sql } from "drizzle-orm"

import { type DatabaseHandle, db } from "@/lib/db/client"
import { monitorDomainHealth } from "@/lib/db/schema"

export interface DomainHealthRow {
  monitorId: string
  hostname: string
  apexDomain: string | null
  certExpiresAt: Date | null
  certIssuer: string | null
  domainExpiresAt: Date | null
  domainRegistrar: string | null
  checkedAt: Date
}

const preserveCertSql = {
  certExpiresAt: sql`case when ${monitorDomainHealth.hostname} = excluded.hostname then coalesce(excluded.cert_expires_at, ${monitorDomainHealth.certExpiresAt}) else excluded.cert_expires_at end`,
  certIssuer: sql`case when ${monitorDomainHealth.hostname} = excluded.hostname then coalesce(excluded.cert_issuer, ${monitorDomainHealth.certIssuer}) else excluded.cert_issuer end`,
}

const overwriteCertSql = {
  certExpiresAt: sql`excluded.cert_expires_at`,
  certIssuer: sql`excluded.cert_issuer`,
}

/**
 * Upserts one row per monitor. A null fact keeps the previous value as long as
 * the hostname (for cert facts) or apex (for domain facts) is unchanged, so a
 * single failed probe never erases a live expiry warning. A changed hostname
 * or apex takes the new values verbatim, nulls included, so facts never
 * outlive the target they described.
 *
 * preserveCertFacts: false overwrites cert columns verbatim instead of
 * coalescing. The cron uses it for monitors that are no longer https, where a
 * null cert is the truth (no certificate in play), not a failed probe, and the
 * old facts must not linger under the unchanged hostname.
 */
export async function upsertDomainHealth(
  rows: readonly DomainHealthRow[],
  options: { preserveCertFacts?: boolean } = {},
  handle: DatabaseHandle = db
): Promise<void> {
  if (rows.length === 0) {
    return
  }
  const certSql =
    options.preserveCertFacts === false ? overwriteCertSql : preserveCertSql
  await handle
    .insert(monitorDomainHealth)
    .values([...rows])
    .onConflictDoUpdate({
      target: monitorDomainHealth.monitorId,
      set: {
        hostname: sql`excluded.hostname`,
        apexDomain: sql`excluded.apex_domain`,
        ...certSql,
        domainExpiresAt: sql`case when ${monitorDomainHealth.apexDomain} = excluded.apex_domain then coalesce(excluded.domain_expires_at, ${monitorDomainHealth.domainExpiresAt}) else excluded.domain_expires_at end`,
        domainRegistrar: sql`case when ${monitorDomainHealth.apexDomain} = excluded.apex_domain then coalesce(excluded.domain_registrar, ${monitorDomainHealth.domainRegistrar}) else excluded.domain_registrar end`,
        checkedAt: sql`excluded.checked_at`,
      },
    })
}
