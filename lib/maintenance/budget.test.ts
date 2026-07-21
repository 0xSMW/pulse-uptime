import { describe, expect, it } from "vitest";

import { createMaintenanceBudget } from "./budget";

describe("createMaintenanceBudget", () => {
  it("reserves the catalog slice below the hard deadline", () => {
    const budget = createMaintenanceBudget({
      nowMs: () => 0,
      hardDeadlineAtMs: 45_000,
      catalogBudgetMs: 10_000,
    });
    expect(budget.hardDeadlineAtMs).toBe(45_000);
    expect(budget.preCatalogDeadlineAtMs).toBe(35_000);
    expect(budget.catalogDeadlineAtMs).toBe(45_000);
    expect(budget.remainingMs("pre_catalog")).toBe(35_000);
    expect(budget.remainingMs("hard")).toBe(45_000);
  });

  it("canStart respects the requested bound and minimum", () => {
    let clock = 34_900;
    const budget = createMaintenanceBudget({
      nowMs: () => clock,
      hardDeadlineAtMs: 45_000,
      catalogBudgetMs: 10_000,
    });
    expect(budget.canStart(200, "pre_catalog")).toBe(false);
    expect(budget.canStart(200, "hard")).toBe(true);
    clock = 44_900;
    expect(budget.canStart(200, "hard")).toBe(false);
  });

  it("records skips and reports deadlineExceeded", () => {
    const budget = createMaintenanceBudget({
      nowMs: () => 0,
      hardDeadlineAtMs: 45_000,
      catalogBudgetMs: 10_000,
    });
    expect(budget.deadlineExceeded).toBe(false);
    budget.recordSkip("compact_15m_recent", "pre_catalog_budget");
    expect(budget.skippedTasks).toEqual([
      { task: "compact_15m_recent", reason: "pre_catalog_budget" },
    ]);
    expect(budget.deadlineExceeded).toBe(true);
  });
});
