import "server-only";

import { db } from "@/lib/db/client";
import { crossCheckMonitoringLoop, type LoopAlertSummary } from "@/lib/monitoring/loop-alert";
import { createSqlCronRunStore, createSqlLeaseStore } from "@/lib/scheduler/sql";
import { queryExecutor } from "@/lib/scheduler/runtime";

import { performSweep, runMaintenanceCoordinator, type SweepSummary } from "./coordinator";
import { createSqlMaintenanceStore } from "./sql";

export function runMaintenanceCron() {
  return runMaintenanceCoordinator({
    leases: createSqlLeaseStore(queryExecutor),
    runs: createSqlCronRunStore(queryExecutor),
    // db is only needed for the dependency catalog's live revalidation step;
    // every other maintenance operation still goes through queryExecutor.
    store: createSqlMaintenanceStore(queryExecutor, db),
  });
}

export async function runSweepCron(): Promise<SweepSummary & { loopAlert: LoopAlertSummary }> {
  const now = new Date();
  const summary = await performSweep(createSqlMaintenanceStore(queryExecutor), now);
  // The loop cross-check is best-effort and independent of the sweep's own
  // work. It must never fail the sweep, which owns short-lived-row cleanup.
  let loopAlert: LoopAlertSummary = {
    checked: false, unhealthy: false, reason: null, recipients: 0, enqueued: 0, sentDirect: 0,
  };
  try {
    loopAlert = await crossCheckMonitoringLoop(now);
  } catch (error) {
    console.error(JSON.stringify({
      event: "system_alert.cross_check_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return { ...summary, loopAlert };
}
