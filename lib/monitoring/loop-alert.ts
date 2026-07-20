import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";

import { findAcceptedSnapshot } from "@/lib/config/accepted-config";
import { db } from "@/lib/db/client";
import { cronRuns } from "@/lib/db/schema";
import { createNotificationMessage } from "@/lib/notifications/message";
import {
  NotificationProviderError,
  createResendSender,
} from "@/lib/notifications/provider";
import { enqueueSystemAlert, markSystemAlertSent } from "@/lib/notifications/system-alert";
import type { SystemAlertPayload } from "@/lib/notifications/types";
import {
  CONSECUTIVE_FAILURE_THRESHOLD,
  evaluateLoopHealth,
  type CronRunStatus,
  type LoopHealthReason,
} from "@/lib/scheduler/loop-health";

// The sweep cron runs every ten minutes on a schedule separate from the
// per-minute monitor-check loop, and it survived the silent-loop incident. It
// therefore cross-checks the monitor-check loop from recorded cron_runs and,
// when the loop is broken, raises a self-alert. The alert is enqueued through
// the normal outbox for the record and for eventual delivery, and because the
// outbox drainer itself rides the broken loop, each newly enqueued row is also
// sent directly here through the same email transport. Deduplication is the
// outbox unique key: a bucket already alerted returns no inserted rows, so
// neither channel fires twice.

const ALERT_KIND = "monitoring-loop-failure";

export type LoopAlertSummary = {
  checked: boolean;
  unhealthy: boolean;
  reason: LoopHealthReason | null;
  recipients: number;
  enqueued: number;
  sentDirect: number;
};

const HEALTHY: LoopAlertSummary = {
  checked: true,
  unhealthy: false,
  reason: null,
  recipients: 0,
  enqueued: 0,
  sentDirect: 0,
};

async function readMonitorLoopSignals(
  limit: number,
): Promise<{ lastCompletedAt: Date | null; recentStatuses: CronRunStatus[] }> {
  const [completed, recent] = await Promise.all([
    db.select({ completedAt: cronRuns.completedAt }).from(cronRuns)
      .where(and(eq(cronRuns.jobName, "monitor-check"), eq(cronRuns.status, "completed")))
      .orderBy(desc(cronRuns.scheduledMinute)).limit(1),
    db.select({ status: cronRuns.status }).from(cronRuns)
      .where(and(
        eq(cronRuns.jobName, "monitor-check"),
        inArray(cronRuns.status, ["completed", "failed"]),
      ))
      .orderBy(desc(cronRuns.scheduledMinute)).limit(limit),
  ]);
  return {
    lastCompletedAt: completed[0]?.completedAt ?? null,
    recentStatuses: recent.map((row) => row.status as CronRunStatus),
  };
}

async function loadAlertRecipients(): Promise<string[]> {
  try {
    const snapshot = await findAcceptedSnapshot();
    return snapshot?.config.settings.defaultRecipients ?? [];
  } catch {
    return [];
  }
}

function alertCopy(reason: LoopHealthReason): { title: string; detail: string } {
  if (reason === "stale") {
    return {
      title: "Pulse monitoring loop is not running",
      detail:
        "The per-minute monitor-check cron has not recorded a completed run recently. "
        + "Monitors are not being checked and outage alerts will not send. "
        + "Confirm the Vercel cron is invoking /api/cron/check-monitors and inspect the latest cron_runs error_detail.",
    };
  }
  return {
    title: "Pulse monitoring checks are failing",
    detail:
      "The monitor-check cron is running but its recent runs all failed. "
      + "Monitors may not be checked and outage alerts may not send. "
      + "Inspect the latest cron_runs error_detail for the recorded failure.",
  };
}

/**
 * Cross-checks the monitor-check loop and alerts when it is broken. Always
 * resolves. It never throws, so a sweep run is never failed by the alerting
 * path. Returns a compact summary for structured logging.
 */
export async function crossCheckMonitoringLoop(now = new Date()): Promise<LoopAlertSummary> {
  const signals = await readMonitorLoopSignals(CONSECUTIVE_FAILURE_THRESHOLD);
  const health = evaluateLoopHealth({
    lastCompletedAt: signals.lastCompletedAt,
    recentStatuses: signals.recentStatuses,
    now,
  });
  if (!health.unhealthy || !health.reason) return HEALTHY;

  const recipients = await loadAlertRecipients();
  const reason = health.reason;
  if (recipients.length === 0) {
    // Honest limit: nothing is configured to receive the alert. The health
    // banner still surfaces the fault to anyone who opens the dashboard.
    console.warn(JSON.stringify({ event: "system_alert.no_recipients", reason }));
    return { checked: true, unhealthy: true, reason, recipients: 0, enqueued: 0, sentDirect: 0 };
  }

  const { title, detail } = alertCopy(reason);
  const enqueued = await enqueueSystemAlert(db, {
    kind: ALERT_KIND,
    title,
    detail,
    reason,
    detectedAt: now,
    recipients,
  }, { now });

  const sender = createResendSender({
    apiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.RESEND_FROM_EMAIL ?? "",
  });
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  let sentDirect = 0;
  for (const row of enqueued) {
    try {
      const message = createNotificationMessage({
        id: row.id,
        incidentId: null,
        monitorId: null,
        dependencyId: null,
        eventType: "system.alert",
        recipient: row.recipient,
        idempotencyKey: row.idempotencyKey,
        payload: row.payload as SystemAlertPayload,
        attemptCount: 0,
        claimToken: "",
      }, appUrl);
      const result = await sender.send(message, row.idempotencyKey);
      await markSystemAlertSent(db, row.id, result.providerMessageId, now);
      sentDirect += 1;
    } catch (error) {
      // Leave the row pending. Once the loop recovers the outbox drainer
      // retries it, and Resend's idempotency key prevents a duplicate send.
      console.warn(JSON.stringify({
        event: "system_alert.direct_send_failed",
        reason,
        errorCode: error instanceof NotificationProviderError ? error.code : "PROVIDER_UNAVAILABLE",
      }));
    }
  }

  console[sentDirect > 0 || enqueued.length > 0 ? "warn" : "info"](JSON.stringify({
    event: "system_alert.monitoring_loop",
    reason,
    recipients: recipients.length,
    enqueued: enqueued.length,
    sentDirect,
  }));

  return { checked: true, unhealthy: true, reason, recipients: recipients.length, enqueued: enqueued.length, sentDirect };
}
