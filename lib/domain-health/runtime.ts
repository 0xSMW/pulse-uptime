import "server-only"

import { requireAcceptedConfig } from "@/lib/api/config-mutation"
import { queryExecutor } from "@/lib/db/query-executor"
import { requirePulseReleaseId } from "@/lib/release/id"
import { runCronCoordinator } from "@/lib/scheduler/cron-coordinator"
import { DOMAIN_HEALTH_LEASE, type LeaseStore } from "@/lib/scheduler/lease"
import type { CronRunStore } from "@/lib/scheduler/run-record"
import { createSqlCronRunStore, createSqlLeaseStore } from "@/lib/scheduler/sql"

import { type CertificateFacts, probeCertificate } from "./cert"
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
      }
      certProbes: number
      rdapLookups: number
      skippedLookups: number
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
  reconcile: (input: DomainHealthReconciliation) => Promise<void>
  now?: () => Date
  nowMs?: () => number
  createId?: () => string
}

export interface DueDomainHealthTargets {
  apexDomains: string[]
  certificates: DomainHealthTargets["certificates"]
}

/** Missing assets and assets at least 24 hours old are due. */
export function selectDueDomainHealthTargets(
  targets: DomainHealthTargets,
  assets: DomainHealthAssetState,
  now: Date
): DueDomainHealthTargets {
  const staleBefore = now.getTime() - DOMAIN_HEALTH_FRESHNESS_MS
  return {
    apexDomains: targets.apexDomains.filter((apex) => {
      const asset = assets.domains.get(apex)
      return !asset?.checkedAt || asset.checkedAt.getTime() <= staleBefore
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
      const due = selectDueDomainHealthTargets(targets, assets, checkedAt)
      const domainRefreshes: DomainHealthRefresh[] = []
      const certificateRefreshes: CertificateHealthRefresh[] = []
      let skippedLookups = 0
      const domainOutcomes = new Map<
        string,
        "success" | "failure" | "skipped"
      >()
      const certificateOutcomes = new Map<
        string,
        "success" | "failure" | "skipped"
      >()

      const rdapTasks = due.apexDomains.map((apex) => async () => {
        if (nowMs() >= admissionDeadlineAtMs) {
          skippedLookups += 1
          domainOutcomes.set(apex, "skipped")
          return
        }
        let facts: DomainFacts
        try {
          facts = await deps.fetchDomain(apex)
        } catch {
          facts = { expiresAt: null, registrar: null }
        }
        domainRefreshes.push({ apexDomain: apex, ...facts, checkedAt })
        domainOutcomes.set(
          apex,
          facts.expiresAt !== null || facts.registrar !== null
            ? "success"
            : "failure"
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
        return outcomes.length > 0 ? ("success" as const) : ("skipped" as const)
      })
      const counts = {
        monitorCount: monitors.length,
        successCount: monitorOutcomes.filter((value) => value === "success")
          .length,
        failureCount: monitorOutcomes.filter((value) => value === "failure")
          .length,
        skippedCount: monitorOutcomes.filter((value) => value === "skipped")
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

      return {
        counts,
        certProbes: certificateRefreshes.length,
        rdapLookups: domainRefreshes.length,
        skippedLookups,
      }
    }
  )) as DomainHealthCronResult
}

export async function runDomainHealthCron(): Promise<DomainHealthCronResult> {
  return runDomainHealthCoordinator({
    leases: createSqlLeaseStore(queryExecutor),
    runs: createSqlCronRunStore(queryExecutor),
    releaseId: requirePulseReleaseId(),
    loadMonitors: async () => (await requireAcceptedConfig()).config.monitors,
    loadAssets: (targets) => loadDomainHealthAssets(targets),
    probeCert: probeCertificate,
    fetchDomain: fetchDomainFacts,
    reconcile: (input) => reconcileDomainHealthAssets(input),
  })
}
