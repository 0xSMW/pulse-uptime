import "server-only"

import { requireAcceptedConfig } from "@/lib/api/config-mutation"
import { queryExecutor } from "@/lib/db/query-executor"
import { requirePulseReleaseId } from "@/lib/release/id"
import { runCronCoordinator } from "@/lib/scheduler/cron-coordinator"
import { DOMAIN_HEALTH_LEASE, type LeaseStore } from "@/lib/scheduler/lease"
import type { CronRunStore } from "@/lib/scheduler/run-record"
import { createSqlCronRunStore, createSqlLeaseStore } from "@/lib/scheduler/sql"

import { apexDomain } from "./apex"
import { type CertificateFacts, probeCertificate } from "./cert"
import { type DomainFacts, fetchDomainFacts } from "./rdap"
import { type DomainHealthRow, upsertDomainHealth } from "./store"

// Route maxDuration is 60s; this reserves headroom for the upsert, run
// finalization, and lease release after the lookup pool settles.
export const DOMAIN_HEALTH_WORK_BUDGET_MS = 52_000
// A lookup admitted at the deadline may still run its full internal timeout
// (10s in cert.ts and rdap.ts), so admission stops this far ahead of the
// budget. Without the margin a slow registry walks the run past maxDuration
// and the function dies before persisting anything.
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
  loadMonitors: () => Promise<Array<{ id: string; url: string }>>
  probeCert: (hostname: string, port: number) => Promise<CertificateFacts>
  fetchDomain: (apex: string) => Promise<DomainFacts>
  persist: (
    rows: DomainHealthRow[],
    options: { preserveCertFacts: boolean }
  ) => Promise<void>
  now?: () => Date
  nowMs?: () => number
  createId?: () => string
}

interface MonitorTarget {
  id: string
  hostname: string
  port: number
  secure: boolean
  apex: string | null
}

function parseTargets(
  monitors: ReadonlyArray<{ id: string; url: string }>
): MonitorTarget[] {
  const targets: MonitorTarget[] = []
  for (const monitor of monitors) {
    let url: URL
    try {
      url = new URL(monitor.url)
    } catch {
      continue
    }
    const secure = url.protocol === "https:"
    targets.push({
      id: monitor.id,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : secure ? 443 : 80,
      secure,
      apex: apexDomain(url.hostname),
    })
  }
  return targets
}

/** Runs tasks with bounded concurrency; a task that throws resolves undefined. */
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
        try {
          await task()
        } catch {
          // Lookup failures degrade to absent facts by design.
        }
      }
    }
  )
  await Promise.all(workers)
}

/**
 * The testable core: one lookup per unique https hostname:port for the leaf
 * certificate and one per unique apex for RDAP, fanned back out to a row per
 * monitor. Lookups that would start after the deadline are skipped; their
 * monitors still get a row so coalescing upserts refresh checked_at without
 * erasing known facts.
 */
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
      const targets = parseTargets(monitors)

      const certByHostPort = new Map<string, CertificateFacts>()
      const domainByApex = new Map<string, DomainFacts>()
      const certKeys = [
        ...new Set(
          targets
            .filter((target) => target.secure)
            .map((target) => `${target.hostname}:${target.port}`)
        ),
      ]
      const apexKeys = [
        ...new Set(
          targets.flatMap((target) => (target.apex ? [target.apex] : []))
        ),
      ]

      let skippedLookups = 0
      const tasks: Array<() => Promise<void>> = [
        ...certKeys.map((key) => async () => {
          if (nowMs() >= admissionDeadlineAtMs) {
            skippedLookups += 1
            return
          }
          const separator = key.lastIndexOf(":")
          const facts = await deps.probeCert(
            key.slice(0, separator),
            Number(key.slice(separator + 1))
          )
          certByHostPort.set(key, facts)
        }),
        ...apexKeys.map((apex) => async () => {
          if (nowMs() >= admissionDeadlineAtMs) {
            skippedLookups += 1
            return
          }
          domainByApex.set(apex, await deps.fetchDomain(apex))
        }),
      ]
      await runPool(tasks, LOOKUP_CONCURRENCY)

      const checkedAt = (deps.now ?? (() => new Date()))()
      const toRow = (target: MonitorTarget): DomainHealthRow => {
        const cert = target.secure
          ? certByHostPort.get(`${target.hostname}:${target.port}`)
          : undefined
        const domain = target.apex ? domainByApex.get(target.apex) : undefined
        return {
          monitorId: target.id,
          hostname: target.hostname,
          apexDomain: target.apex,
          certExpiresAt: cert?.expiresAt ?? null,
          certIssuer: cert?.issuer ?? null,
          domainExpiresAt: domain?.expiresAt ?? null,
          domainRegistrar: domain?.registrar ?? null,
          checkedAt,
        }
      }
      // Secure targets coalesce so a failed probe keeps known cert facts. A
      // target that is no longer https overwrites its cert facts with null,
      // the truth for a monitor with no certificate in play.
      const secureRows = targets.filter((t) => t.secure).map(toRow)
      const insecureRows = targets.filter((t) => !t.secure).map(toRow)
      const rows = [...secureRows, ...insecureRows]

      const counts = {
        monitorCount: monitors.length,
        successCount: rows.filter(
          (row) =>
            row.certExpiresAt !== null ||
            row.certIssuer !== null ||
            row.domainExpiresAt !== null ||
            row.domainRegistrar !== null
        ).length,
        failureCount: 0,
        skippedCount: skippedLookups,
      }
      progress.record(counts)
      await deps.persist(secureRows, { preserveCertFacts: true })
      await deps.persist(insecureRows, { preserveCertFacts: false })

      return {
        counts,
        certProbes: certByHostPort.size,
        rdapLookups: domainByApex.size,
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
    // Disabled monitors are included: the dashboard still lists them, so their
    // rows must keep refreshing or a paused monitor would wear a stale expiry
    // warning forever.
    loadMonitors: async () => (await requireAcceptedConfig()).config.monitors,
    probeCert: probeCertificate,
    fetchDomain: fetchDomainFacts,
    persist: (rows, options) => upsertDomainHealth(rows, options),
  })
}
