import "server-only"

import { and, desc, eq, inArray } from "drizzle-orm"

import { findAcceptedSnapshot } from "@/lib/config/accepted-config"
import { db } from "@/lib/db/client"
import { cronRuns } from "@/lib/db/schema"
import { enqueueSystemAlert } from "@/lib/notifications/system-alert"
import {
  CONSECUTIVE_FAILURE_THRESHOLD,
  type CronRunStatus,
  evaluateLoopHealth,
  type LoopHealthReason,
} from "@/lib/scheduler/loop-health"

// The sweep cron runs every ten minutes on a schedule separate from the
// per-minute monitor-check loop, and it survived the silent-loop incident. It
// therefore cross-checks the monitor-check loop from recorded cron_runs and,
// when the loop is broken, enqueues a durable system.alert. Delivery is owned
// by the outbox state machine: the sweep drains system.alert rows after this
// enqueue so alerts still leave even when the monitor-check drainer is down.
// Deduplication is the outbox unique key: a bucket already alerted returns no
// inserted rows, while existing failed rows are claimed and retried.

const ALERT_KIND = "monitoring-loop-failure"

export interface LoopAlertSummary {
  checked: boolean
  unhealthy: boolean
  reason: LoopHealthReason | null
  failures: number
  recipients: number
  enqueued: number
}

const HEALTHY: LoopAlertSummary = {
  checked: true,
  unhealthy: false,
  reason: null,
  failures: 0,
  recipients: 0,
  enqueued: 0,
}

async function readMonitorLoopSignals(
  limit: number
): Promise<{ lastCompletedAt: Date | null; recentStatuses: CronRunStatus[] }> {
  const [completed, recent] = await Promise.all([
    db
      .select({ completedAt: cronRuns.completedAt })
      .from(cronRuns)
      .where(
        and(
          eq(cronRuns.jobName, "monitor-check"),
          eq(cronRuns.status, "completed")
        )
      )
      .orderBy(desc(cronRuns.scheduledMinute))
      .limit(1),
    db
      .select({ status: cronRuns.status })
      .from(cronRuns)
      .where(
        and(
          eq(cronRuns.jobName, "monitor-check"),
          inArray(cronRuns.status, ["completed", "failed"])
        )
      )
      .orderBy(desc(cronRuns.scheduledMinute))
      .limit(limit),
  ])
  return {
    lastCompletedAt: completed[0]?.completedAt ?? null,
    recentStatuses: recent.map((row) => row.status as CronRunStatus),
  }
}

async function loadAlertRecipients(): Promise<string[]> {
  try {
    const snapshot = await findAcceptedSnapshot()
    return snapshot?.config.settings.defaultRecipients ?? []
  } catch {
    return []
  }
}

function alertCopy(reason: LoopHealthReason): {
  title: string
  detail: string
} {
  if (reason === "stale") {
    return {
      title: "Pulse monitoring loop is not running",
      detail:
        "The per-minute monitor-check cron has not recorded a completed run recently. " +
        "Monitors are not being checked and outage alerts will not send. " +
        "Confirm the Vercel cron is invoking /api/cron/check-monitors and inspect the latest cron_runs error_detail.",
    }
  }
  return {
    title: "Pulse monitoring checks are failing",
    detail:
      "The monitor-check cron is running but its recent runs all failed. " +
      "Monitors may not be checked and outage alerts may not send. " +
      "Inspect the latest cron_runs error_detail for the recorded failure.",
  }
}

/**
 * Cross-checks the monitor-check loop and enqueues durable system.alert work
 * when it is broken. Always resolves. It never throws, so a sweep run is never
 * failed by the alerting path. Delivery is left to the outbox drain that runs
 * after this enqueue on the same sweep. Returns a compact summary for logs.
 */
export async function crossCheckMonitoringLoop(
  now = new Date()
): Promise<LoopAlertSummary> {
  const signals = await readMonitorLoopSignals(CONSECUTIVE_FAILURE_THRESHOLD)
  const health = evaluateLoopHealth({
    lastCompletedAt: signals.lastCompletedAt,
    recentStatuses: signals.recentStatuses,
    now,
  })
  if (!(health.unhealthy && health.reason)) {
    return { ...HEALTHY, failures: health.failures }
  }

  const recipients = await loadAlertRecipients()
  const reason = health.reason
  if (recipients.length === 0) {
    // Honest limit: nothing is configured to receive the alert. The health
    // banner still surfaces the fault to anyone who opens the dashboard.
    console.warn(
      JSON.stringify({ event: "system_alert.no_recipients", reason })
    )
    return {
      checked: true,
      unhealthy: true,
      reason,
      failures: health.failures,
      recipients: 0,
      enqueued: 0,
    }
  }

  const { title, detail } = alertCopy(reason)
  const enqueued = await enqueueSystemAlert(
    db,
    {
      kind: ALERT_KIND,
      title,
      detail,
      reason,
      detectedAt: now,
      recipients,
    },
    { now }
  )

  console[enqueued.length > 0 ? "warn" : "info"](
    JSON.stringify({
      event: "system_alert.monitoring_loop",
      reason,
      failures: health.failures,
      recipients: recipients.length,
      enqueued: enqueued.length,
    })
  )

  return {
    checked: true,
    unhealthy: true,
    reason,
    failures: health.failures,
    recipients: recipients.length,
    enqueued: enqueued.length,
  }
}
