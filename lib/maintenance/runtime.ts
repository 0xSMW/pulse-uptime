import "server-only";

import { db } from "@/lib/db/client";
import { crossCheckMonitoringLoop, type LoopAlertSummary } from "@/lib/monitoring/loop-alert";
import {
  deliverPendingNotifications,
  type DeliverySummary,
} from "@/lib/notifications/delivery";
import { createResendSender } from "@/lib/notifications/provider";
import { reconcileStaleClaims } from "@/lib/notifications/sql";
import { requirePulseReleaseId } from "@/lib/release/id";
import { createSqlCronRunStore, createSqlLeaseStore } from "@/lib/scheduler/sql";
import { queryExecutor } from "@/lib/scheduler/runtime";

import { performSweep, runMaintenanceCoordinator, type SweepSummary } from "./coordinator";
import { createSqlMaintenanceStore } from "./sql";

// Sweep is an independent system.alert consumer. It only claims that event
// type so it never races the ordinary monitor-check outbox drain for
// incident/dependency rows. Bound is small: loop self-alerts are rare.
const SYSTEM_ALERT_EVENT_TYPES = ["system.alert"] as const;
const SYSTEM_ALERT_DELIVERY_LIMIT = 50;
const SYSTEM_ALERT_DELIVERY_CONCURRENCY = 5;

export type SystemAlertDeliverySummary = DeliverySummary & {
  staleClaimsReconciled: number;
};

const EMPTY_SYSTEM_ALERT_DELIVERY: SystemAlertDeliverySummary = {
  staleClaimsReconciled: 0,
  claimed: 0,
  sent: 0,
  failed: 0,
  dead: 0,
  lostClaims: 0,
};

const EMPTY_LOOP_ALERT: LoopAlertSummary = {
  checked: false,
  unhealthy: false,
  reason: null,
  failures: 0,
  recipients: 0,
  enqueued: 0,
};

export function runMaintenanceCron() {
  return runMaintenanceCoordinator({
    leases: createSqlLeaseStore(queryExecutor),
    runs: createSqlCronRunStore(queryExecutor),
    releaseId: requirePulseReleaseId(),
    // db is only needed for the dependency catalog's live revalidation step;
    // every other maintenance operation still goes through queryExecutor.
    store: createSqlMaintenanceStore(queryExecutor, db),
  });
}

/**
 * Runs short-lived-row cleanup, then the monitoring-loop cross-check, then a
 * bounded system.alert outbox drain. The drain always runs, even when the
 * cross-check inserted zero rows, so failed or stale-claimed alerts still
 * retry while the monitor-check loop is down.
 */
export async function runSweepCron(): Promise<SweepSummary & {
  loopAlert: LoopAlertSummary;
  systemAlertDelivery: SystemAlertDeliverySummary;
}> {
  const now = new Date();
  const summary = await performSweep(createSqlMaintenanceStore(queryExecutor), now);

  let loopAlert: LoopAlertSummary = EMPTY_LOOP_ALERT;
  try {
    loopAlert = await crossCheckMonitoringLoop(now);
  } catch (error) {
    console.error(JSON.stringify({
      event: "system_alert.cross_check_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  let systemAlertDelivery: SystemAlertDeliverySummary = EMPTY_SYSTEM_ALERT_DELIVERY;
  try {
    const staleClaimsReconciled = await reconcileStaleClaims(
      queryExecutor,
      now,
      5 * 60_000,
      { eventTypes: SYSTEM_ALERT_EVENT_TYPES },
    );
    const sender = createResendSender({
      apiKey: process.env.RESEND_API_KEY ?? "",
      from: process.env.RESEND_FROM_EMAIL ?? "",
    });
    const delivery = await deliverPendingNotifications({
      db: queryExecutor,
      sender,
      appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
      now: () => now,
      log: (entry) => console.info(JSON.stringify(entry)),
    }, {
      limit: SYSTEM_ALERT_DELIVERY_LIMIT,
      concurrency: SYSTEM_ALERT_DELIVERY_CONCURRENCY,
      eventTypes: SYSTEM_ALERT_EVENT_TYPES,
    });
    systemAlertDelivery = { ...delivery, staleClaimsReconciled };
  } catch (error) {
    console.error(JSON.stringify({
      event: "system_alert.delivery_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  return { ...summary, loopAlert, systemAlertDelivery };
}
