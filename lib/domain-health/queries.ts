import { and, eq, inArray, or } from "drizzle-orm"

import type { DatabaseHandle } from "@/lib/db/client"
import { db } from "@/lib/db/client"
import { certificateHealthAssets, domainHealthAssets } from "@/lib/db/schema"

import { certificateAssetKey, deriveDomainHealthTargets } from "./targets"

export interface SerializedDomainHealthFacts {
  apexDomain: string | null
  certExpiresAt: string | null
  certIssuer: string | null
  domainExpiresAt: string | null
  domainRegistrar: string | null
}

/**
 * Fans two shared-asset reads back out to the current monitor response shape.
 * Missing assets and facts serialize as null.
 */
export async function domainHealthByMonitorId(
  monitors: readonly { id: string; url: string }[],
  handle: DatabaseHandle = db
): Promise<Map<string, SerializedDomainHealthFacts>> {
  const targets = deriveDomainHealthTargets(monitors)
  const [domainRows, certificateRows] = await Promise.all([
    targets.apexDomains.length === 0
      ? Promise.resolve([])
      : handle
          .select({
            apexDomain: domainHealthAssets.apexDomain,
            expiresAt: domainHealthAssets.expiresAt,
            registrar: domainHealthAssets.registrar,
          })
          .from(domainHealthAssets)
          .where(inArray(domainHealthAssets.apexDomain, targets.apexDomains)),
    targets.certificates.length === 0
      ? Promise.resolve([])
      : handle
          .select({
            hostname: certificateHealthAssets.hostname,
            port: certificateHealthAssets.port,
            expiresAt: certificateHealthAssets.expiresAt,
            issuer: certificateHealthAssets.issuer,
          })
          .from(certificateHealthAssets)
          .where(
            or(
              ...targets.certificates.map((target) =>
                and(
                  eq(certificateHealthAssets.hostname, target.hostname),
                  eq(certificateHealthAssets.port, target.port)
                )
              )
            )
          ),
  ])
  const domains = new Map(domainRows.map((row) => [row.apexDomain, row]))
  const certificates = new Map(
    certificateRows.map((row) => [
      certificateAssetKey(row.hostname, row.port),
      row,
    ])
  )
  const result = new Map<string, SerializedDomainHealthFacts>(
    monitors.map((monitor) => [
      monitor.id,
      {
        apexDomain: null,
        certExpiresAt: null,
        certIssuer: null,
        domainExpiresAt: null,
        domainRegistrar: null,
      },
    ])
  )
  for (const target of targets.monitors) {
    const domain = target.apexDomain
      ? domains.get(target.apexDomain)
      : undefined
    const certificate = target.certificate
      ? certificates.get(
          certificateAssetKey(
            target.certificate.hostname,
            target.certificate.port
          )
        )
      : undefined
    result.set(target.id, {
      apexDomain: target.apexDomain,
      certExpiresAt: certificate?.expiresAt?.toISOString() ?? null,
      certIssuer: certificate?.issuer ?? null,
      domainExpiresAt: domain?.expiresAt?.toISOString() ?? null,
      domainRegistrar: domain?.registrar ?? null,
    })
  }
  return result
}
