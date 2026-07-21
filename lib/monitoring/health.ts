import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import { db } from "@/lib/db/client"
import {
  cronRuns,
  dependencies,
  monitoringConfigSnapshots,
  notificationOutbox,
} from "@/lib/db/schema"
import type { HealthWarning } from "@/lib/monitoring/types"
import {
  CONSECUTIVE_FAILURE_THRESHOLD,
  type CronRunStatus,
  countLeadingFailures,
} from "@/lib/scheduler/loop-health"

export async function getHealthWarnings(
  now = new Date()
): Promise<HealthWarning[]> {
  const [
    checkRun,
    maintenanceRun,
    dependencyRun,
    installedDependency,
    rejected,
    dead,
    recentChecks,
  ] = await Promise.all([
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
      .select({ completedAt: cronRuns.completedAt })
      .from(cronRuns)
      .where(
        and(
          eq(cronRuns.jobName, "maintenance"),
          eq(cronRuns.status, "completed")
        )
      )
      .orderBy(desc(cronRuns.scheduledMinute))
      .limit(1),
    db
      .select({ completedAt: cronRuns.completedAt })
      .from(cronRuns)
      .where(
        and(
          eq(cronRuns.jobName, "check-dependencies"),
          eq(cronRuns.status, "completed")
        )
      )
      .orderBy(desc(cronRuns.scheduledMinute))
      .limit(1),
    db
      .select({ id: dependencies.id })
      .from(dependencies)
      .where(isNull(dependencies.removedAt))
      .limit(1),
    db
      .select({ status: monitoringConfigSnapshots.status })
      .from(monitoringConfigSnapshots)
      .orderBy(desc(monitoringConfigSnapshots.seenAt))
      .limit(1),
    db
      .select({ id: notificationOutbox.id })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.status, "dead"))
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
      .limit(CONSECUTIVE_FAILURE_THRESHOLD),
  ])

  const warnings: HealthWarning[] = []
  const lastCheck = checkRun[0]?.completedAt
  if (!lastCheck || now.getTime() - lastCheck.getTime() > 3 * 60_000) {
    warnings.push({
      code: "MONITORING_STALE",
      message: "Scheduled checks are delayed",
      action: "Check Vercel Cron",
    })
  }
  // A loop that runs but throws every minute leaves failed rows rather than
  // going stale. Reading the last few terminal runs newest-first, an unbroken
  // streak of failures at or past the threshold means the loop is executing
  // but never succeeding. Its full error is now captured in cron_runs.
  const leadingFailures = countLeadingFailures(
    recentChecks.map((row) => row.status as CronRunStatus)
  )
  if (leadingFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
    warnings.push({
      code: "MONITORING_FAILING",
      message: "Scheduled checks are failing",
      action: "Check Cron Errors",
    })
  }
  // check-dependencies runs every minute like monitor-check, so it shares the
  // same 3 minute staleness bound. Only a completed run advances completedAt,
  // so a poller stuck failing or not running goes stale here just as the
  // monitor cron does. A source is polled only when it has an installed,
  // non-removed dependency, so a fresh install with nothing installed has no
  // poller work and must not raise a stale poller warning.
  const lastDependencyCheck = dependencyRun[0]?.completedAt
  if (
    installedDependency.length > 0 &&
    (!lastDependencyCheck ||
      now.getTime() - lastDependencyCheck.getTime() > 3 * 60_000)
  ) {
    warnings.push({
      code: "DEPENDENCY_POLLER_STALE",
      message: "Dependency updates are delayed",
      action: "Check Vercel Cron",
    })
  }
  if (rejected[0]?.status === "rejected") {
    warnings.push({
      code: "CONFIG_REJECTED",
      message: "Configuration changes were rejected",
      action: "Review Settings",
    })
  }
  if (dead.length > 0) {
    warnings.push({
      code: "NOTIFICATION_DEAD",
      message: "Some alerts could not send",
      action: "Review Notifications",
    })
  }
  const lastMaintenance = maintenanceRun[0]?.completedAt
  if (
    !lastMaintenance ||
    now.getTime() - lastMaintenance.getTime() > 48 * 60 * 60_000
  ) {
    warnings.push({
      code: "MAINTENANCE_STALE",
      message: "Maintenance has not completed recently",
      action: "Check Maintenance",
    })
  }
  return warnings
}
