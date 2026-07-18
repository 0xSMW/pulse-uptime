import { describe, expect, it } from "vitest";

import { excludedQueries, queryCases } from "../src/query-cases";
import { validateInventoryStatically } from "../src/validate";

describe("validateInventoryStatically", () => {
  it("connects nowhere and reports no issues for the real inventory", () => {
    const report = validateInventoryStatically();
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.queryCaseCount).toBe(queryCases.length);
    expect(report.excludedQueryCount).toBe(excludedQueries.length);
  });

  it("has a non-trivial, uniquely-named inventory", () => {
    expect(queryCases.length).toBeGreaterThan(10);
    const names = new Set(queryCases.map((entry) => entry.name));
    expect(names.size).toBe(queryCases.length);
  });

  it("gives every excluded query a real reason, not a placeholder", () => {
    expect(excludedQueries.length).toBeGreaterThan(0);
    for (const excluded of excludedQueries) {
      expect(excluded.reason.length).toBeGreaterThan(20);
    }
  });
});
