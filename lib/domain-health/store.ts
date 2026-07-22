import { and, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm"

import { lockConfiguration } from "@/lib/api/configuration-lock"
import { type DatabaseHandle, db } from "@/lib/db/client"
import {
  certificateHealthAssets,
  domainHealthAssets,
  monitorRegistry,
} from "@/lib/db/schema"

import {
  certificateAssetKey,
  type DomainHealthTargets,
  deriveDomainHealthTargets,
} from "./targets"

export interface DomainHealthAsset {
  apexDomain: string
  expiresAt: Date | null
  registrar: string | null
  checkedAt: Date | null
  lastSuccessAt: Date | null
  lastReferencedAt: Date
}

export interface CertificateHealthAsset {
  hostname: string
  port: number
  expiresAt: Date | null
  issuer: string | null
  checkedAt: Date | null
  lastSuccessAt: Date | null
  lastReferencedAt: Date
}

export interface DomainHealthAssetState {
  domains: Map<string, DomainHealthAsset>
  certificates: Map<string, CertificateHealthAsset>
}

export interface DomainHealthRefresh {
  apexDomain: string
  expiresAt: Date | null
  registrar: string | null
  checkedAt: Date
}

export interface CertificateHealthRefresh {
  hostname: string
  port: number
  expiresAt: Date | null
  issuer: string | null
  checkedAt: Date
}

export interface DomainHealthReconciliation {
  domains: readonly DomainHealthRefresh[]
  certificates: readonly CertificateHealthRefresh[]
  referencedAt: Date
  pruneBefore: Date
}

/** Loads shared assets for cron freshness checks and query-side fanout. */
export async function loadDomainHealthAssets(
  targets: DomainHealthTargets,
  handle: DatabaseHandle = db
): Promise<DomainHealthAssetState> {
  const [domainRows, certificateRows] = await Promise.all([
    targets.apexDomains.length === 0
      ? Promise.resolve([])
      : handle
          .select()
          .from(domainHealthAssets)
          .where(inArray(domainHealthAssets.apexDomain, targets.apexDomains)),
    targets.certificates.length === 0
      ? Promise.resolve([])
      : handle
          .select()
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

  return {
    domains: new Map(domainRows.map((row) => [row.apexDomain, row])),
    certificates: new Map(
      certificateRows.map((row) => [
        certificateAssetKey(row.hostname, row.port),
        row,
      ])
    ),
  }
}

/**
 * Persists attempted refreshes and prunes assets absent from the accepted
 * configuration in one transaction. Null refresh facts preserve the latest
 * known non-null values while checked_at still records the attempt.
 */
export async function reconcileDomainHealthAssets(
  input: DomainHealthReconciliation,
  handle: DatabaseHandle = db
): Promise<void> {
  await handle.transaction(async (tx) => {
    await lockConfiguration(tx)
    const currentMonitors = await tx
      .select({ id: monitorRegistry.id, url: monitorRegistry.url })
      .from(monitorRegistry)
      .where(isNull(monitorRegistry.archivedAt))
    const currentTargets = deriveDomainHealthTargets(currentMonitors)

    if (currentTargets.apexDomains.length > 0) {
      await tx
        .insert(domainHealthAssets)
        .values(
          currentTargets.apexDomains.map((apexDomain) => ({
            apexDomain,
            checkedAt: null,
            lastReferencedAt: input.referencedAt,
          }))
        )
        .onConflictDoUpdate({
          target: domainHealthAssets.apexDomain,
          set: { lastReferencedAt: sql`excluded.last_referenced_at` },
        })
    }
    if (currentTargets.certificates.length > 0) {
      await tx
        .insert(certificateHealthAssets)
        .values(
          currentTargets.certificates.map((target) => ({
            ...target,
            checkedAt: null,
            lastReferencedAt: input.referencedAt,
          }))
        )
        .onConflictDoUpdate({
          target: [
            certificateHealthAssets.hostname,
            certificateHealthAssets.port,
          ],
          set: { lastReferencedAt: sql`excluded.last_referenced_at` },
        })
    }

    if (input.domains.length > 0) {
      await tx
        .insert(domainHealthAssets)
        .values(
          input.domains.map((row) => ({
            ...row,
            lastSuccessAt:
              row.expiresAt !== null || row.registrar !== null
                ? row.checkedAt
                : null,
            lastReferencedAt: input.referencedAt,
          }))
        )
        .onConflictDoUpdate({
          target: domainHealthAssets.apexDomain,
          set: {
            expiresAt: sql`coalesce(excluded.expires_at, ${domainHealthAssets.expiresAt})`,
            registrar: sql`coalesce(excluded.registrar, ${domainHealthAssets.registrar})`,
            checkedAt: sql`excluded.checked_at`,
            lastSuccessAt: sql`coalesce(excluded.last_success_at, ${domainHealthAssets.lastSuccessAt})`,
            lastReferencedAt: sql`excluded.last_referenced_at`,
          },
        })
    }

    if (input.certificates.length > 0) {
      await tx
        .insert(certificateHealthAssets)
        .values(
          input.certificates.map((row) => ({
            ...row,
            lastSuccessAt:
              row.expiresAt !== null || row.issuer !== null
                ? row.checkedAt
                : null,
            lastReferencedAt: input.referencedAt,
          }))
        )
        .onConflictDoUpdate({
          target: [
            certificateHealthAssets.hostname,
            certificateHealthAssets.port,
          ],
          set: {
            expiresAt: sql`coalesce(excluded.expires_at, ${certificateHealthAssets.expiresAt})`,
            issuer: sql`coalesce(excluded.issuer, ${certificateHealthAssets.issuer})`,
            checkedAt: sql`excluded.checked_at`,
            lastSuccessAt: sql`coalesce(excluded.last_success_at, ${certificateHealthAssets.lastSuccessAt})`,
            lastReferencedAt: sql`excluded.last_referenced_at`,
          },
        })
    }

    const staleDomainReference = lt(
      domainHealthAssets.lastReferencedAt,
      input.pruneBefore
    )
    await tx
      .delete(domainHealthAssets)
      .where(
        currentTargets.apexDomains.length === 0
          ? staleDomainReference
          : and(
              staleDomainReference,
              notInArray(
                domainHealthAssets.apexDomain,
                currentTargets.apexDomains
              )
            )
      )

    // Raw sql template parameters bypass drizzle's column mapping, so every
    // value must be a pre-serialized string with an explicit SQL cast. A bare
    // number makes referenced.port text and the integer comparison fails with
    // 42883, and a bare Date fails to bind at all on unprepared statements.
    await tx.delete(certificateHealthAssets).where(
      currentTargets.certificates.length === 0
        ? lt(certificateHealthAssets.lastReferencedAt, input.pruneBefore)
        : sql`${certificateHealthAssets.lastReferencedAt} < ${input.pruneBefore.toISOString()}::timestamptz
          and not exists (
          select 1
          from (values ${sql.join(
            currentTargets.certificates.map(
              (target) => sql`(${target.hostname}, ${String(target.port)}::int)`
            ),
            sql`, `
          )}) as referenced(hostname, port)
          where referenced.hostname = ${certificateHealthAssets.hostname}
            and referenced.port = ${certificateHealthAssets.port}
        )`
    )
  })
}
