import "server-only";

import { createSqlCronRunStore, createSqlLeaseStore } from "@/lib/scheduler/sql";
import { queryExecutor } from "@/lib/scheduler/runtime";

import { runMaintenanceCoordinator } from "./coordinator";
import { createSqlMaintenanceStore } from "./sql";

export function runMaintenanceCron() {
  return runMaintenanceCoordinator({
    leases: createSqlLeaseStore(queryExecutor),
    runs: createSqlCronRunStore(queryExecutor),
    store: createSqlMaintenanceStore(queryExecutor),
  });
}
