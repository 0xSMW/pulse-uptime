import { describe, expect, it } from "vitest";

import type { Artifact } from "../src/artifact";
import { compareArtifacts, DEFAULT_THRESHOLDS } from "../src/compare";
import type { ExplainSample, QueryCaseResult } from "../src/explain";

function sample(overrides: Partial<ExplainSample> = {}): ExplainSample {
  return {
    totalTimeMs: 1,
    planningTimeMs: 0.1,
    executionTimeMs: 0.9,
    sharedHitBlocks: 10,
    sharedReadBlocks: 2,
    sharedDirtiedBlocks: 0,
    sharedWrittenBlocks: 0,
    rootRows: 100,
    nodeCount: 3,
    topNodes: [],
    ...overrides,
  };
}

function result(name: string, samples: ExplainSample[]): QueryCaseResult {
  return {
    name,
    description: "test case",
    source: "test",
    mutating: false,
    paramShape: "[]",
    warmup: samples[0]!,
    samples,
  };
}

function emptyCardinalities(): Artifact["fixture"]["cardinalities"] {
  return {} as Artifact["fixture"]["cardinalities"];
}

function artifact(
  label: string,
  results: QueryCaseResult[],
  fixture: Artifact["fixture"] = { version: 1, cardinalities: emptyCardinalities() },
): Artifact {
  return {
    schemaVersion: 1,
    label,
    createdAt: new Date(0).toISOString(),
    projectId: "test-project",
    regionId: "test-region",
    fixture,
    run: { warmupCount: 1, repeatCount: samplesCount(results) },
    results,
    excluded: [],
  };
}

function samplesCount(results: QueryCaseResult[]): number {
  return results[0]?.samples.length ?? 0;
}

describe("compareArtifacts", () => {
  it("reports unchanged when execution time and buffers are stable", () => {
    const baseline = artifact("baseline", [result("case-a", [sample(), sample(), sample()])]);
    const candidate = artifact("candidate", [result("case-a", [sample(), sample(), sample()])]);
    const report = compareArtifacts(baseline, candidate);
    expect(report.hasRegression).toBe(false);
    expect(report.cases[0]!.verdict).toBe("unchanged");
  });

  it("flags a regression when execution time worsens beyond threshold and the absolute floor", () => {
    const baseline = artifact("baseline", [result("case-a", [sample({ executionTimeMs: 1 })])]);
    const candidate = artifact("candidate", [result("case-a", [sample({ executionTimeMs: 5 })])]);
    const report = compareArtifacts(baseline, candidate, DEFAULT_THRESHOLDS);
    expect(report.hasRegression).toBe(true);
    expect(report.cases[0]!.verdict).toBe("regressed");
    expect(report.cases[0]!.reasons.some((reason) => reason.includes("Execution time regressed"))).toBe(true);
  });

  it("does not flag noise below the absolute-ms floor even if the percentage is large", () => {
    const baseline = artifact("baseline", [result("case-a", [sample({ executionTimeMs: 0.001 })])]);
    const candidate = artifact("candidate", [result("case-a", [sample({ executionTimeMs: 0.01 })])]);
    const report = compareArtifacts(baseline, candidate, DEFAULT_THRESHOLDS);
    expect(report.hasRegression).toBe(false);
  });

  it("flags a regression when shared buffer reads blow up", () => {
    const baseline = artifact("baseline", [result("case-a", [sample({ sharedReadBlocks: 5 })])]);
    const candidate = artifact("candidate", [result("case-a", [sample({ sharedReadBlocks: 500 })])]);
    const report = compareArtifacts(baseline, candidate, DEFAULT_THRESHOLDS);
    expect(report.hasRegression).toBe(true);
    expect(report.cases[0]!.reasons.some((reason) => reason.includes("Shared buffer reads regressed"))).toBe(true);
  });

  it("marks improvement when execution time drops well past the threshold", () => {
    const baseline = artifact("baseline", [result("case-a", [sample({ executionTimeMs: 10 })])]);
    const candidate = artifact("candidate", [result("case-a", [sample({ executionTimeMs: 1 })])]);
    const report = compareArtifacts(baseline, candidate, DEFAULT_THRESHOLDS);
    expect(report.hasRegression).toBe(false);
    expect(report.cases[0]!.verdict).toBe("improved");
  });

  it("uses the median across samples, ignoring a single outlier", () => {
    const baseline = artifact("baseline", [result("case-a", [sample({ executionTimeMs: 1 }), sample({ executionTimeMs: 1 }), sample({ executionTimeMs: 1 })])]);
    const candidate = artifact("candidate", [result("case-a", [sample({ executionTimeMs: 1 }), sample({ executionTimeMs: 1 }), sample({ executionTimeMs: 100 })])]);
    const report = compareArtifacts(baseline, candidate, DEFAULT_THRESHOLDS);
    expect(report.hasRegression).toBe(false);
    expect(report.cases[0]!.verdict).toBe("unchanged");
  });

  it("flags cases missing from the candidate or baseline instead of silently dropping them", () => {
    const baseline = artifact("baseline", [result("only-in-baseline", [sample()])]);
    const candidate = artifact("candidate", [result("only-in-candidate", [sample()])]);
    const report = compareArtifacts(baseline, candidate);
    const byName = new Map(report.cases.map((entry) => [entry.name, entry]));
    expect(byName.get("only-in-baseline")!.verdict).toBe("missing-in-candidate");
    expect(byName.get("only-in-candidate")!.verdict).toBe("missing-in-baseline");
  });

  it("flags a root row-count change even without a time/buffer regression", () => {
    const baseline = artifact("baseline", [result("case-a", [sample({ rootRows: 100 })])]);
    const candidate = artifact("candidate", [result("case-a", [sample({ rootRows: 50 })])]);
    const report = compareArtifacts(baseline, candidate);
    expect(report.cases[0]!.rowCountChanged).toBe(true);
    expect(report.cases[0]!.reasons.some((reason) => reason.includes("Root row count changed"))).toBe(true);
  });

  it("flags a regression when shared buffer reads go from a fully-warm zero baseline to a large candidate value", () => {
    // A zero read baseline uses the absolute block threshold.
    const baseline = artifact("baseline", [result("case-a", [sample({ sharedReadBlocks: 0 })])]);
    const candidate = artifact("candidate", [result("case-a", [sample({ sharedReadBlocks: 500 })])]);
    const report = compareArtifacts(baseline, candidate, DEFAULT_THRESHOLDS);
    expect(report.hasRegression).toBe(true);
    expect(report.cases[0]!.verdict).toBe("regressed");
    expect(report.cases[0]!.bufferReadDeltaPct).toBeNull();
    expect(report.cases[0]!.reasons.some((reason) => reason.includes("Shared buffer reads regressed from 0"))).toBe(true);
  });

  it("does not flag a zero-baseline buffer case below the absolute-blocks floor", () => {
    const baseline = artifact("baseline", [result("case-a", [sample({ sharedReadBlocks: 0 })])]);
    const candidate = artifact("candidate", [result("case-a", [sample({ sharedReadBlocks: 3 })])]);
    const report = compareArtifacts(baseline, candidate, DEFAULT_THRESHOLDS);
    expect(report.hasRegression).toBe(false);
  });

  it("does not flag a zero-baseline, zero-candidate buffer case", () => {
    const baseline = artifact("baseline", [result("case-a", [sample({ sharedReadBlocks: 0 })])]);
    const candidate = artifact("candidate", [result("case-a", [sample({ sharedReadBlocks: 0 })])]);
    const report = compareArtifacts(baseline, candidate, DEFAULT_THRESHOLDS);
    expect(report.hasRegression).toBe(false);
    expect(report.cases[0]!.verdict).toBe("unchanged");
  });

  it("passes and has no missing/row-count flags when everything is unchanged", () => {
    const baseline = artifact("baseline", [result("case-a", [sample()])]);
    const candidate = artifact("candidate", [result("case-a", [sample()])]);
    const report = compareArtifacts(baseline, candidate);
    expect(report.passed).toBe(true);
    expect(report.hasMissingCases).toBe(false);
    expect(report.hasRowCountChanges).toBe(false);
  });

  it("fails (passed=false, hasMissingCases=true) when a case is missing from the candidate", () => {
    const baseline = artifact("baseline", [result("case-a", [sample()]), result("case-b", [sample()])]);
    const candidate = artifact("candidate", [result("case-a", [sample()])]);
    const report = compareArtifacts(baseline, candidate);
    expect(report.hasMissingCases).toBe(true);
    expect(report.hasRegression).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("fails (passed=false, hasRowCountChanges=true) when a case's row count changed", () => {
    const baseline = artifact("baseline", [result("case-a", [sample({ rootRows: 100 })])]);
    const candidate = artifact("candidate", [result("case-a", [sample({ rootRows: 50 })])]);
    const report = compareArtifacts(baseline, candidate);
    expect(report.hasRowCountChanges).toBe(true);
    expect(report.hasRegression).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("does not fail for a case that is new in the candidate (missing-in-baseline)", () => {
    const baseline = artifact("baseline", [result("case-a", [sample()])]);
    const candidate = artifact("candidate", [result("case-a", [sample()]), result("case-b", [sample()])]);
    const report = compareArtifacts(baseline, candidate);
    const byName = new Map(report.cases.map((entry) => [entry.name, entry]));
    expect(byName.get("case-b")!.verdict).toBe("missing-in-baseline");
    expect(report.hasMissingCases).toBe(false);
    expect(report.hasRowCountChanges).toBe(false);
    expect(report.passed).toBe(true);
  });

  it("fails when fixture versions differ even if all cases pass", () => {
    const baseline = artifact("baseline", [result("case-a", [sample()])], {
      version: 1,
      cardinalities: emptyCardinalities(),
    });
    const candidate = artifact("candidate", [result("case-a", [sample()])], {
      version: 2,
      cardinalities: emptyCardinalities(),
    });
    const report = compareArtifacts(baseline, candidate);
    expect(report.hasFixtureMismatch).toBe(true);
    expect(report.hasRegression).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.fixtureMismatchReasons.some((reason) => reason.includes("Fixture version differs"))).toBe(true);
  });

  it("fails when a cardinality key is missing from the candidate", () => {
    const baseline = artifact("baseline", [result("case-a", [sample()])], {
      version: 1,
      cardinalities: { monitor_registry: 100 } as Artifact["fixture"]["cardinalities"],
    });
    const candidate = artifact("candidate", [result("case-a", [sample()])], {
      version: 1,
      cardinalities: emptyCardinalities(),
    });
    const report = compareArtifacts(baseline, candidate);
    expect(report.hasFixtureMismatch).toBe(true);
    expect(report.passed).toBe(false);
    expect(
      report.fixtureMismatchReasons.some((reason) =>
        reason.includes('Cardinality key "monitor_registry" is missing from the candidate'),
      ),
    ).toBe(true);
  });

  it("fails when a cardinality key is extra in the candidate", () => {
    const baseline = artifact("baseline", [result("case-a", [sample()])], {
      version: 1,
      cardinalities: emptyCardinalities(),
    });
    const candidate = artifact("candidate", [result("case-a", [sample()])], {
      version: 1,
      cardinalities: { monitor_registry: 100 } as Artifact["fixture"]["cardinalities"],
    });
    const report = compareArtifacts(baseline, candidate);
    expect(report.hasFixtureMismatch).toBe(true);
    expect(report.passed).toBe(false);
    expect(
      report.fixtureMismatchReasons.some((reason) =>
        reason.includes('Cardinality key "monitor_registry" is extra in the candidate'),
      ),
    ).toBe(true);
  });

  it("fails when a cardinality value differs", () => {
    const baseline = artifact("baseline", [result("case-a", [sample()])], {
      version: 1,
      cardinalities: { monitor_registry: 100 } as Artifact["fixture"]["cardinalities"],
    });
    const candidate = artifact("candidate", [result("case-a", [sample()])], {
      version: 1,
      cardinalities: { monitor_registry: 200 } as Artifact["fixture"]["cardinalities"],
    });
    const report = compareArtifacts(baseline, candidate);
    expect(report.hasFixtureMismatch).toBe(true);
    expect(report.passed).toBe(false);
    expect(
      report.fixtureMismatchReasons.some((reason) =>
        reason.includes('Cardinality for "monitor_registry" differs') &&
        reason.includes("100") &&
        reason.includes("200"),
      ),
    ).toBe(true);
  });

  it("passes fixture checks when version and cardinalities match", () => {
    const fixture: Artifact["fixture"] = {
      version: 2,
      cardinalities: {
        monitor_registry: 100,
        monitor_state: 100,
      } as Artifact["fixture"]["cardinalities"],
    };
    const baseline = artifact("baseline", [result("case-a", [sample()])], fixture);
    const candidate = artifact("candidate", [result("case-a", [sample()])], {
      version: 2,
      cardinalities: {
        monitor_registry: 100,
        monitor_state: 100,
      } as Artifact["fixture"]["cardinalities"],
    });
    const report = compareArtifacts(baseline, candidate);
    expect(report.hasFixtureMismatch).toBe(false);
    expect(report.fixtureMismatchReasons).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
