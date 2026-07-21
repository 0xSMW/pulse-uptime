import type { MonitorConfig } from "@/lib/config/schema"

import type { CronRunCounts } from "./run-record"
import { isDueAt } from "./time"

const DISPATCH_CUTOFF_MS = 45_000
const FUNCTION_MAX_DURATION_MS = 60_000
const CHECK_COMPLETION_BUFFER_MS = 8000
const MAX_ACTIVE_MONITORS = 100

export type MonitorRunOutcome = "success" | "failure" | "duplicate"

export type MonitorRunner = (
  monitor: MonitorConfig,
  scheduledAt: Date
) => Promise<MonitorRunOutcome>

export async function dispatchDueMonitors(options: {
  monitors: readonly MonitorConfig[]
  scheduledAt: Date
  invocationStartedAtMs: number
  nowMs: () => number
  concurrency: number
  run: MonitorRunner
}): Promise<CronRunCounts> {
  const active = options.monitors.filter((monitor) => monitor.enabled)
  if (active.length > MAX_ACTIVE_MONITORS) {
    throw new Error("Active monitor limit exceeded")
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new RangeError("Concurrency must be a positive integer")
  }

  const due = active.filter((monitor) => isDueAt(monitor, options.scheduledAt))
  const counts: CronRunCounts = {
    monitorCount: due.length,
    successCount: 0,
    failureCount: 0,
    skippedCount: 0,
  }
  let cursor = 0

  const workers = Array.from(
    { length: Math.min(options.concurrency, due.length) },
    async () => {
      while (cursor < due.length) {
        const monitor = due[cursor]
        cursor += 1
        if (!monitor) {
          continue
        }
        const elapsed = options.nowMs() - options.invocationStartedAtMs
        const remainingFunctionTime = FUNCTION_MAX_DURATION_MS - elapsed
        if (
          elapsed >= DISPATCH_CUTOFF_MS ||
          remainingFunctionTime < monitor.timeoutMs + CHECK_COMPLETION_BUFFER_MS
        ) {
          counts.skippedCount += 1
          continue
        }
        try {
          const outcome = await options.run(monitor, options.scheduledAt)
          if (outcome === "success") {
            counts.successCount += 1
          } else if (outcome === "failure") {
            counts.failureCount += 1
          } else {
            counts.skippedCount += 1
          }
        } catch {
          counts.failureCount += 1
        }
      }
    }
  )
  await Promise.all(workers)
  return counts
}
