// Maintenance wall-clock budget. Splits the overall work window into a
// pre-catalog slice (retention, compaction, gap recovery, usage) and a reserved
// catalog slice so heavy night work never starves dependency feed validation.

export type MaintenanceBudgetBound = "hard" | "pre_catalog" | "catalog";

export type MaintenanceSkipReason =
  | "hard_deadline"
  | "pre_catalog_budget"
  | "catalog_budget";

export type MaintenanceSkippedTask = {
  task: string;
  reason: MaintenanceSkipReason;
};

export type MaintenanceBudget = {
  readonly hardDeadlineAtMs: number;
  readonly catalogDeadlineAtMs: number;
  readonly preCatalogDeadlineAtMs: number;
  remainingMs(bound?: MaintenanceBudgetBound): number;
  canStart(minimumMs: number, bound?: MaintenanceBudgetBound): boolean;
  recordSkip(task: string, reason: MaintenanceSkipReason): void;
  readonly skippedTasks: readonly MaintenanceSkippedTask[];
  readonly deadlineExceeded: boolean;
};

export type CreateMaintenanceBudgetInput = {
  nowMs: () => number;
  hardDeadlineAtMs: number;
  /** Reserved catalog validation slice width in ms. */
  catalogBudgetMs: number;
};

/**
 * Builds a maintenance budget from the overall hard deadline and the reserved
 * catalog slice. Pre-catalog work must finish by hard - catalogBudget so the
 * catalog pass always has a reserved opportunity when the hard window remains.
 */
export function createMaintenanceBudget(input: CreateMaintenanceBudgetInput): MaintenanceBudget {
  const { nowMs, hardDeadlineAtMs, catalogBudgetMs } = input;
  const preCatalogDeadlineAtMs = hardDeadlineAtMs - catalogBudgetMs;
  // Catalog may use the reserved slice and any leftover pre-catalog time, but
  // never past the hard window.
  const catalogDeadlineAtMs = hardDeadlineAtMs;
  const skips: MaintenanceSkippedTask[] = [];

  function deadlineFor(bound: MaintenanceBudgetBound): number {
    switch (bound) {
      case "hard":
        return hardDeadlineAtMs;
      case "pre_catalog":
        return preCatalogDeadlineAtMs;
      case "catalog":
        return catalogDeadlineAtMs;
    }
  }

  return {
    hardDeadlineAtMs,
    catalogDeadlineAtMs,
    preCatalogDeadlineAtMs,
    remainingMs(bound: MaintenanceBudgetBound = "hard") {
      return Math.max(0, deadlineFor(bound) - nowMs());
    },
    canStart(minimumMs: number, bound: MaintenanceBudgetBound = "pre_catalog") {
      return deadlineFor(bound) - nowMs() >= minimumMs;
    },
    recordSkip(task: string, reason: MaintenanceSkipReason) {
      skips.push({ task, reason });
    },
    get skippedTasks() {
      return skips;
    },
    get deadlineExceeded() {
      return skips.length > 0 || nowMs() >= hardDeadlineAtMs;
    },
  };
}

/** Minimum remaining ms required to start a typical SQL maintenance step. */
export const MIN_MAINTENANCE_TASK_MS = 100;

/** Minimum remaining ms required to start a retention drain batch. */
export const MIN_RETENTION_BATCH_MS = 250;

/** Minimum remaining ms required to start usage measurement. */
export const MIN_USAGE_MEASUREMENT_MS = 500;

/** Minimum remaining ms required to start catalog reconciliation. */
export const MIN_CATALOG_TASK_MS = 250;
