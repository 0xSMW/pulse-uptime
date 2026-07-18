import { and, desc, eq } from "drizzle-orm";

import type { HealthWarning } from "@/components/dashboard/health-banner";
import { db } from "@/lib/db/client";
import { cronRuns, monitoringConfigSnapshots, notificationOutbox } from "@/lib/db/schema";

export async function getHealthWarnings(now = new Date()): Promise<HealthWarning[]> {
  const [checkRun, maintenanceRun, rejected, dead] = await Promise.all([
    db.select({ completedAt: cronRuns.completedAt }).from(cronRuns)
      .where(and(eq(cronRuns.jobName, "check-monitors"), eq(cronRuns.status, "completed")))
      .orderBy(desc(cronRuns.scheduledMinute)).limit(1),
    db.select({ completedAt: cronRuns.completedAt }).from(cronRuns)
      .where(and(eq(cronRuns.jobName, "maintenance"), eq(cronRuns.status, "completed")))
      .orderBy(desc(cronRuns.scheduledMinute)).limit(1),
    db.select({ status: monitoringConfigSnapshots.status }).from(monitoringConfigSnapshots)
      .orderBy(desc(monitoringConfigSnapshots.seenAt)).limit(1),
    db.select({ id: notificationOutbox.id }).from(notificationOutbox)
      .where(eq(notificationOutbox.status, "dead")).limit(1),
  ]);

  const warnings: HealthWarning[] = [];
  const lastCheck = checkRun[0]?.completedAt;
  if (!lastCheck || now.getTime() - lastCheck.getTime() > 3 * 60_000) {
    warnings.push({
      code: "MONITORING_STALE",
      message: "Scheduled checks are delayed",
      action: "Check Vercel Cron",
    });
  }
  if (rejected[0]?.status === "rejected") {
    warnings.push({
      code: "CONFIG_REJECTED",
      message: "Configuration changes were rejected",
      action: "Review Settings",
    });
  }
  if (dead.length > 0) {
    warnings.push({
      code: "NOTIFICATION_DEAD",
      message: "Some alerts could not send",
      action: "Review Notifications",
    });
  }
  const lastMaintenance = maintenanceRun[0]?.completedAt;
  if (!lastMaintenance || now.getTime() - lastMaintenance.getTime() > 48 * 60 * 60_000) {
    warnings.push({
      code: "MAINTENANCE_STALE",
      message: "Maintenance has not completed recently",
      action: "Check Maintenance",
    });
  }
  return warnings;
}
