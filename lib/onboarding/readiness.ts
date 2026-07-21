import "server-only"

import {
  abortSignalForDeadline,
  deadlineRemainingMs,
} from "@/lib/async/deadline"
import type { QueryFn } from "@/lib/db/query-executor"
import { queryExecutor } from "@/lib/db/query-executor"
import {
  createDatabaseProbe,
  createEdgeConfigProbe,
  createEmailProbe,
  createVercelProbe,
} from "@/lib/readiness/probes"
import { runReadinessChecks } from "@/lib/readiness/service"
import type {
  ReadinessProbeOptions,
  ReadinessReport,
} from "@/lib/readiness/types"

export const ONBOARDING_READINESS_TIMEOUT_MS = 9000
export const ONBOARDING_READINESS_CACHE_TTL_MS = 30_000

let cachedReport: { expiresAt: number; report: ReadinessReport } | null = null
let inFlightReport: Promise<ReadinessReport> | null = null

/**
 * Cached readiness used by the HTTP route. Concurrent cold misses share one
 * in-flight probe. The shared flight uses a deadline-only abort signal so one
 * client disconnect cannot cancel peers. Only canContinue reports are cached.
 */
export async function getOnboardingReadiness(
  options: { deadlineAtMs?: number; signal?: AbortSignal; nowMs?: number } = {}
): Promise<ReadinessReport> {
  const nowMs = options.nowMs ?? Date.now()
  if (cachedReport && cachedReport.expiresAt > nowMs) {
    return cachedReport.report
  }

  if (!inFlightReport) {
    // Flight budget is wall-clock only. Callers may pass request.signal for
    // their own wait cancellation later; the shared probes must not bind to it.
    const deadlineAtMs =
      options.deadlineAtMs ?? nowMs + ONBOARDING_READINESS_TIMEOUT_MS
    const signal = abortSignalForDeadline(deadlineAtMs, nowMs)
    inFlightReport = checkOnboardingReadiness({ deadlineAtMs, signal })
      .then((report) => {
        if (report.canContinue) {
          cachedReport = {
            expiresAt: Date.now() + ONBOARDING_READINESS_CACHE_TTL_MS,
            report,
          }
        }
        return report
      })
      .finally(() => {
        inFlightReport = null
      })
  }

  return inFlightReport
}

/** Absolute deadline + abort bound every provider probe. */
export async function checkOnboardingReadiness(
  options: { deadlineAtMs?: number; signal?: AbortSignal } = {}
): Promise<ReadinessReport> {
  const deadlineAtMs =
    options.deadlineAtMs ?? Date.now() + ONBOARDING_READINESS_TIMEOUT_MS
  const signal = options.signal ?? abortSignalForDeadline(deadlineAtMs)
  const probeOptions: ReadinessProbeOptions = { deadlineAtMs, signal }

  const probes = {
    vercel: createVercelProbe(),
    database: createDatabaseProbe(probeDatabase),
    edge: createEdgeConfigProbe(),
    email: createEmailProbe(),
  }

  return runReadinessChecks(probes, probeOptions)
}

/**
 * One connection with transaction-local statement_timeout. The temporary
 * table transaction still rolls back deliberately after the write probe.
 */
async function probeDatabase(options: ReadinessProbeOptions): Promise<void> {
  const remainingMs = deadlineRemainingMs(options.deadlineAtMs)
  if (remainingMs <= 0 || options.signal.aborted) {
    throw new Error("READINESS_DEADLINE")
  }

  const rollback = new Error("READINESS_ROLLBACK")
  try {
    await queryExecutor.withStatementTimeout(remainingMs, async (query) => {
      await query("select id from admin_users limit 1", [])
      await writeTempProbe(query)
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) {
      throw error
    }
  }
}

async function writeTempProbe(query: QueryFn): Promise<void> {
  await query(
    "create temporary table pulse_readiness_probe (id integer) on commit drop",
    []
  )
  await query("insert into pulse_readiness_probe (id) values (1)", [])
}

/** Clears completed cache and any in-flight coalescing. Tests only. */
export function resetOnboardingReadinessCache(): void {
  cachedReport = null
  inFlightReport = null
}

/** Visible to tests that assert in-flight cleanup. */
export function getOnboardingReadinessInFlightForTests(): Promise<ReadinessReport> | null {
  return inFlightReport
}
