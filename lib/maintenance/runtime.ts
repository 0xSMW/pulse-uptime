import "server-only";

import { db } from "@/lib/db/client";
import { createSqlCronRunStore, createSqlLeaseStore } from "@/lib/scheduler/sql";
import { queryExecutor } from "@/lib/scheduler/runtime";

import { performSweep, runMaintenanceCoordinator } from "./coordinator";
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

export function runSweepCron() {
  return performSweep(createSqlMaintenanceStore(queryExecutor), new Date());
}
