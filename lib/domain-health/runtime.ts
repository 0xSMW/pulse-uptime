import "server-only"

import { requireAcceptedConfig } from "@/lib/api/config-mutation"
import { db } from "@/lib/db/client"
import { queryExecutor } from "@/lib/db/query-executor"
import { createDomainExpiryOutboxEnqueuer } from "@/lib/notifications/domain-expiry"
import {
  readPorkbunIntegration,
  upsertPorkbunIntegration,
} from "@/lib/porkbun-webhooks/store"
import { requirePulseReleaseId } from "@/lib/release/id"
import { runCronCoordinator } from "@/lib/scheduler/cron-coordinator"
import { DOMAIN_HEALTH_LEASE, type LeaseStore } from "@/lib/scheduler/lease"
import type { CronRunStore } from "@/lib/scheduler/run-record"
import { createSqlCronRunStore, createSqlLeaseStore } from "@/lib/scheduler/sql"

import {
  buildDomainExpiryAlertRows,
  type DomainExpiryOutboxEnqueuer,
} from "./alerts"
import { type CertificateFacts, probeCertificate } from "./cert"
import {
  fetchPorkbunAccountDomains,
  type PorkbunDomainLookup,
  type PorkbunDomainRenewalFacts,
} from "./porkbun"
import { type DomainFacts, fetchDomainFacts } from "./rdap"
import {
  type CertificateHealthRefresh,
  type DomainHealthAssetState,
  type DomainHealthReconciliation,
  type DomainHealthRefresh,
  loadDomainHealthAssets,
  reconcileDomainHealthAssets,
} from "./store"
import {
  certificateAssetKey,
  type DomainHealthMonitor,
  type DomainHealthTargets,
  deriveDomainHealthTargets,
} from "./targets"

export const DOMAIN_HEALTH_WORK_BUDGET_MS = 52_000
export const DOMAIN_HEALTH_FRESHNESS_MS = 24 * 60 * 60 * 1000
export const DOMAIN_HEALTH_PRUNE_GRACE_MS = 48 * 60 * 60 * 1000
const LOOKUP_ADMISSION_MARGIN_MS = 11_000
const LOOKUP_CONCURRENCY = 4

export type DomainHealthCronResult =
  | { status: "lease-held" }
  | { status: "duplicate"; runId: string }
  | {
      status: "completed"
      runId: string
      counts: {
        monitorCount: number
        successCount: number
        failureCount: number
        skippedCount: number
        unknownCount: number
      }
      certProbes: number
      rdapLookups: number
      skippedLookups: number
      /** Forced webhook apexes refreshed from Porkbun and durably reconciled. */
      porkbunRefreshedApexDomains: string[]
    }
  | { status: "failed"; runId: string; error: string }

export interface DomainHealthCronDeps {
  leases: LeaseStore
  runs: CronRunStore
  releaseId: string
  loadMonitors: () => Promise<DomainHealthMonitor[]>
  loadAssets: (targets: DomainHealthTargets) => Promise<DomainHealthAssetState>
  probeCert: (hostname: string, port: number) => Promise<CertificateFacts>
  fetchDomain: (apex: string) => Promise<DomainFacts>
  fetchPorkbunDomains?: () => Promise<PorkbunDomainLookup>
  recordPorkbunLookup?: (summary: PorkbunLookupSummary) => Promise<void>
  reconcile: (input: DomainHealthReconciliation) => Promise<void>
  domainExpiryAlerts?: DomainExpiryAlertHooks
  /** Verified webhook apexes may bypass the normal daily freshness gate. */
  forcedApexDomains?: ReadonlySet<string>
  now?: () => Date
  nowMs?: () => number
  createId?: () => string
}

export interface PorkbunLookupSummary {
  checkedAt: Date
  success: boolean
  error: "unconfigured" | "rate-limited" | "failed" | null
  coveredDomainCount: number
}

export interface DomainExpiryAlertHooks {
  enabled: boolean
  defaultRecipients: readonly string[]
  persist: DomainExpiryOutboxEnqueuer
}

export interface DueDomainHealthTargets {
  apexDomains: string[]
  certificates: DomainHealthTargets["certificates"]
}

/** Missing and stale assets are due, plus expirations unseen since they elapsed. */
export function selectDueDomainHealthTargets(
  targets: DomainHealthTargets,
  assets: DomainHealthAssetState,
  now: Date,
  forcedApexDomains: ReadonlySet<string> = new Set()
): DueDomainHealthTargets {
  const staleBefore = now.getTime() - DOMAIN_HEALTH_FRESHNESS_MS
  return {
    apexDomains: targets.apexDomains.filter((apex) => {
      const asset = assets.domains.get(apex)
      return (
        forcedApexDomains.has(apex) ||
        !asset?.checkedAt ||
        asset.checkedAt.getTime() <= staleBefore ||
        (asset.expiresAt !== null &&
          asset.expiresAt.getTime() <= now.getTime() &&
          asset.checkedAt.getTime() <= asset.expiresAt.getTime())
      )
    }),
    certificates: targets.certificates.filter((target) => {
      const asset = assets.certificates.get(
        certificateAssetKey(target.hostname, target.port)
      )
      return !asset?.checkedAt || asset.checkedAt.getTime() <= staleBefore
    }),
  }
}

async function runPool(
  tasks: ReadonlyArray<() => Promise<void>>,
  concurrency: number
): Promise<void> {
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    async () => {
      while (cursor < tasks.length) {
        const task = tasks[cursor]
        cursor += 1
        if (!task) {
          continue
        }
        await task()
      }
    }
  )
  await Promise.all(workers)
}

function interleaveTasks(
  first: ReadonlyArray<() => Promise<void>>,
  second: ReadonlyArray<() => Promise<void>>
): Array<() => Promise<void>> {
  const tasks: Array<() => Promise<void>> = []
  const length = Math.max(first.length, second.length)
  for (let index = 0; index < length; index += 1) {
    const firstTask = first[index]
    const secondTask = second[index]
    if (firstTask) {
      tasks.push(firstTask)
    }
    if (secondTask) {
      tasks.push(secondTask)
    }
  }
  return tasks
}

/** Runs due shared-asset lookups with fair, bounded admission. */
export async function runDomainHealthCoordinator(
  deps: DomainHealthCronDeps
): Promise<DomainHealthCronResult> {
  const nowMs = deps.nowMs ?? Date.now
  const admissionDeadlineAtMs =
    nowMs() + DOMAIN_HEALTH_WORK_BUDGET_MS - LOOKUP_ADMISSION_MARGIN_MS

  return (await runCronCoordinator(
    {
      leases: deps.leases,
      runs: deps.runs,
      leaseName: DOMAIN_HEALTH_LEASE,
      jobName: "check-domains",
      releaseId: deps.releaseId,
      now: deps.now,
      createId: deps.createId,
    },
    async ({ progress }) => {
      const monitors = await deps.loadMonitors()
      const targets = deriveDomainHealthTargets(monitors)
      const assets = await deps.loadAssets(targets)
      const checkedAt = (deps.now ?? (() => new Date()))()
      const due = selectDueDomainHealthTargets(
        targets,
        assets,
        checkedAt,
        deps.forcedApexDomains
      )
      let porkbun: PorkbunDomainLookup = {
        outcome: "unconfigured",
        domains: [],
      }
      const shouldReadPorkbun = due.apexDomains.length > 0
      if (shouldReadPorkbun && deps.fetchPorkbunDomains) {
        try {
          porkbun = await deps.fetchPorkbunDomains()
        } catch {
          porkbun = { outcome: "failed", domains: [], reason: "network" }
        }
      }
      const porkbunDomains = new Map<string, PorkbunDomainRenewalFacts>(
        porkbun.outcome === "resolved"
          ? porkbun.domains
              .filter((domain) => domain.notLocal !== true)
              .map((domain) => [domain.domain, domain])
          : []
      )
      if (
        shouldReadPorkbun &&
        deps.fetchPorkbunDomains &&
        deps.recordPorkbunLookup
      ) {
        await deps.recordPorkbunLookup({
          checkedAt,
          success: porkbun.outcome === "resolved",
          error: porkbun.outcome === "resolved" ? null : porkbun.outcome,
          coveredDomainCount: targets.apexDomains.filter((apex) =>
            porkbunDomains.has(apex)
          ).length,
        })
      }
      const domainRefreshes: DomainHealthRefresh[] = []
      const certificateRefreshes: CertificateHealthRefresh[] = []
      let rdapLookups = 0
      let skippedLookups = 0
      const domainOutcomes = new Map<
        string,
        "success" | "failure" | "skipped" | "unknown"
      >()
      const certificateOutcomes = new Map<
        string,
        "success" | "failure" | "skipped" | "unknown"
      >()

      // The portfolio decides the source for every apex, while the existing
      // daily freshness gate still bounds persistence work per asset.
      const porkbunRefreshes = due.apexDomains.flatMap((apex) => {
        const facts = porkbunDomains.get(apex)
        if (!facts) {
          return []
        }
        return [
          {
            apexDomain: apex,
            expiresAt: facts.expiresAt,
            registrar: "Porkbun",
            registrationSource: "porkbun" as const,
            autoRenew: facts.autoRenew,
            registrationStatus: facts.status,
            checkedAt,
          },
        ]
      })
      domainRefreshes.push(...porkbunRefreshes)
      for (const refresh of porkbunRefreshes) {
        domainOutcomes.set(
          refresh.apexDomain,
          refresh.expiresAt !== null ||
            refresh.autoRenew !== null ||
            refresh.registrationStatus !== null
            ? "success"
            : "unknown"
        )
      }

      const rdapTasks = due.apexDomains
        .filter((apex) => {
          if (porkbun.outcome === "resolved") {
            return !porkbunDomains.has(apex)
          }
          // A provider outage must not replace known Porkbun facts with RDAP.
          // Missing credentials leave RDAP as the fallback until Porkbun is
          // configured.
          return (
            porkbun.outcome === "unconfigured" ||
            assets.domains.get(apex)?.registrationSource !== "porkbun"
          )
        })
        .map((apex) => async () => {
          if (nowMs() >= admissionDeadlineAtMs) {
            skippedLookups += 1
            domainOutcomes.set(apex, "skipped")
            return
          }
          let facts: DomainFacts
          try {
            rdapLookups += 1
            facts = await deps.fetchDomain(apex)
          } catch {
            facts = { expiresAt: null, registrar: null, outcome: "failed" }
          }
          // Failed lookups must not mutate a known registration source or its
          // facts. An answered RDAP non-coverage result is different: its null
          // facts are deliberately reconciled so an obsolete Porkbun value does
          // not read as a current expiry after ownership changes.
          if (facts.outcome !== "failed") {
            domainRefreshes.push({
              apexDomain: apex,
              expiresAt: facts.expiresAt,
              registrar: facts.registrar,
              registrationSource: "rdap",
              autoRenew: null,
              registrationStatus: null,
              checkedAt,
            })
          }
          // A lookup that answered without facts is unknown, not a failure.
          // RDAP non-coverage is permanent for some TLDs and must not read as
          // a probe regression in the run record.
          domainOutcomes.set(
            apex,
            facts.outcome === "failed"
              ? "failure"
              : facts.expiresAt !== null || facts.registrar !== null
                ? "success"
                : "unknown"
          )
        })
      const certTasks = due.certificates.map((target) => async () => {
        const key = certificateAssetKey(target.hostname, target.port)
        if (nowMs() >= admissionDeadlineAtMs) {
          skippedLookups += 1
          certificateOutcomes.set(key, "skipped")
          return
        }
        let facts: CertificateFacts
        try {
          facts = await deps.probeCert(target.hostname, target.port)
        } catch {
          facts = { expiresAt: null, issuer: null }
        }
        certificateRefreshes.push({ ...target, ...facts, checkedAt })
        certificateOutcomes.set(
          key,
          facts.expiresAt !== null || facts.issuer !== null
            ? "success"
            : "failure"
        )
      })

      await runPool(interleaveTasks(rdapTasks, certTasks), LOOKUP_CONCURRENCY)

      const targetsByMonitorId = new Map(
        targets.monitors.map((target) => [target.id, target])
      )
      const monitorOutcomes = monitors.map((monitor) => {
        const target = targetsByMonitorId.get(monitor.id)
        if (!target) {
          return "skipped" as const
        }
        const outcomes = [
          target.apexDomain === null
            ? undefined
            : domainOutcomes.get(target.apexDomain),
          target.certificate === null
            ? undefined
            : certificateOutcomes.get(
                certificateAssetKey(
                  target.certificate.hostname,
                  target.certificate.port
                )
              ),
        ].filter((outcome) => outcome !== undefined)
        if (outcomes.includes("failure")) {
          return "failure" as const
        }
        if (outcomes.includes("skipped")) {
          return "skipped" as const
        }
        if (outcomes.includes("success")) {
          return "success" as const
        }
        // Every lookup answered and none produced facts.
        return outcomes.length > 0 ? ("unknown" as const) : ("skipped" as const)
      })
      const counts = {
        monitorCount: monitors.length,
        successCount: monitorOutcomes.filter((value) => value === "success")
          .length,
        failureCount: monitorOutcomes.filter((value) => value === "failure")
          .length,
        skippedCount: monitorOutcomes.filter((value) => value === "skipped")
          .length,
        unknownCount: monitorOutcomes.filter((value) => value === "unknown")
          .length,
      }
      progress.record(counts)
      await deps.reconcile({
        domains: domainRefreshes,
        certificates: certificateRefreshes,
        referencedAt: checkedAt,
        pruneBefore: new Date(
          checkedAt.getTime() - DOMAIN_HEALTH_PRUNE_GRACE_MS
        ),
      })
      // Reconciliation is transactional. Reaching this point proves every
      // listed Porkbun refresh was persisted, so webhook receipt handling can
      // acknowledge only these exact apexes.
      const porkbunRefreshedApexDomains = porkbunRefreshes.map(
        (refresh) => refresh.apexDomain
      )
      if (deps.domainExpiryAlerts) {
        const registrations = new Map(
          [...assets.domains.values()]
            .filter((asset) => asset.registrationSource === "porkbun")
            .map((asset) => [
              asset.apexDomain,
              {
                apexDomain: asset.apexDomain,
                expiresAt: asset.expiresAt,
                autoRenew: asset.autoRenew ?? null,
              },
            ])
        )
        for (const refresh of domainRefreshes) {
          if (refresh.registrationSource === "porkbun") {
            registrations.set(refresh.apexDomain, {
              apexDomain: refresh.apexDomain,
              expiresAt: refresh.expiresAt,
              autoRenew: refresh.autoRenew ?? null,
            })
          } else {
            registrations.delete(refresh.apexDomain)
          }
        }
        const rows = buildDomainExpiryAlertRows({
          settings: { enabled: deps.domainExpiryAlerts.enabled },
          registrations: [...registrations.values()],
          defaultRecipients: deps.domainExpiryAlerts.defaultRecipients,
          now: checkedAt,
          createId: deps.createId ?? crypto.randomUUID,
        })
        if (rows.length > 0) {
          await deps.domainExpiryAlerts.persist(rows)
        }
      }

      return {
        counts,
        certProbes: certificateRefreshes.length,
        rdapLookups,
        skippedLookups,
        porkbunRefreshedApexDomains,
      }
    }
  )) as DomainHealthCronResult
}

export async function runDomainHealthCron(
  forcedApexDomains?: ReadonlySet<string>
): Promise<DomainHealthCronResult> {
  const [acceptedConfig, integration] = await Promise.all([
    requireAcceptedConfig(),
    readPorkbunIntegration(),
  ])
  return runDomainHealthCoordinator({
    leases: createSqlLeaseStore(queryExecutor),
    runs: createSqlCronRunStore(queryExecutor),
    releaseId: requirePulseReleaseId(),
    loadMonitors: async () => acceptedConfig.config.monitors,
    loadAssets: (targets) => loadDomainHealthAssets(targets),
    probeCert: probeCertificate,
    fetchDomain: fetchDomainFacts,
    fetchPorkbunDomains: fetchPorkbunAccountDomains,
    recordPorkbunLookup: async (summary) => {
      await upsertPorkbunIntegration({
        coveredDomainCount: summary.coveredDomainCount,
        providerCheckedAt: summary.checkedAt,
        providerLastErrorCode: summary.error?.toUpperCase() ?? null,
        providerLastSuccessAt: summary.success ? summary.checkedAt : undefined,
      })
    },
    reconcile: (input) => reconcileDomainHealthAssets(input),
    domainExpiryAlerts: {
      enabled: integration?.expiryAlertsEnabled ?? false,
      defaultRecipients: acceptedConfig.config.settings.defaultRecipients,
      persist: createDomainExpiryOutboxEnqueuer(db),
    },
    forcedApexDomains,
  })
}
