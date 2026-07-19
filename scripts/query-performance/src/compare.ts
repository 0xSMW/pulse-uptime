// Compare benchmark artifacts using median samples. Percentage regressions
// must also exceed an absolute threshold.

import type { Artifact } from "./artifact";
import type { ExplainSample, QueryCaseResult } from "./explain";

export interface Thresholds {
  timeRegressionPct: number;
  bufferRegressionPct: number;
  minAbsoluteMs: number;
  minAbsoluteBlocks: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  timeRegressionPct: 20,
  bufferRegressionPct: 30,
  minAbsoluteMs: 0.05,
  minAbsoluteBlocks: 8,
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function medianSample(samples: ExplainSample[]): {
  executionTimeMs: number;
  totalTimeMs: number;
  sharedReadBlocks: number;
  sharedHitBlocks: number;
  rootRows: number;
} {
  return {
    executionTimeMs: median(samples.map((sample) => sample.executionTimeMs)),
    totalTimeMs: median(samples.map((sample) => sample.totalTimeMs)),
    sharedReadBlocks: median(samples.map((sample) => sample.sharedReadBlocks)),
    sharedHitBlocks: median(samples.map((sample) => sample.sharedHitBlocks)),
    rootRows: median(samples.map((sample) => sample.rootRows)),
  };
}

export type Verdict = "improved" | "unchanged" | "regressed" | "missing-in-candidate" | "missing-in-baseline";

export interface CaseComparison {
  name: string;
  verdict: Verdict;
  baseline: ReturnType<typeof medianSample> | null;
  candidate: ReturnType<typeof medianSample> | null;
  executionTimeDeltaPct: number | null;
  bufferReadDeltaPct: number | null;
  rowCountChanged: boolean;
  reasons: string[];
}

export interface ComparisonReport {
  createdAt: string;
  baselineLabel: string;
  candidateLabel: string;
  thresholds: Thresholds;
  cases: CaseComparison[];
  hasRegression: boolean;
  // True when a baseline case is missing from the candidate.
  hasMissingCases: boolean;
  // True when a root row count differs between artifacts.
  hasRowCountChanges: boolean;
  // True when fixture version or cardinalities differ between artifacts.
  hasFixtureMismatch: boolean;
  // Human-readable reasons for any fixture metadata mismatch.
  fixtureMismatchReasons: string[];
  // True when project, region, or run configuration differs between artifacts.
  hasMetadataMismatch: boolean;
  // Human-readable per-field reasons for any run metadata mismatch.
  metadataMismatchReasons: string[];
  // True when no regression, missing candidate case, row count change,
  // fixture mismatch, or run metadata mismatch exists.
  passed: boolean;
}

function pctDelta(baselineValue: number, candidateValue: number): number | null {
  if (baselineValue === 0) return candidateValue === 0 ? 0 : null;
  return ((candidateValue - baselineValue) / baselineValue) * 100;
}

// Reject comparisons across different fixture versions or cardinalities.
function compareFixtureMetadata(
  baseline: Artifact["fixture"],
  candidate: Artifact["fixture"],
): { hasFixtureMismatch: boolean; fixtureMismatchReasons: string[] } {
  const reasons: string[] = [];

  if (baseline.version !== candidate.version) {
    reasons.push(
      `Fixture version differs (baseline ${baseline.version} -> candidate ${candidate.version}).`,
    );
  }

  const baselineKeys = Object.keys(baseline.cardinalities);
  const candidateKeys = Object.keys(candidate.cardinalities);
  const allKeys = [...new Set([...baselineKeys, ...candidateKeys])].sort();

  for (const key of allKeys) {
    const inBaseline = Object.prototype.hasOwnProperty.call(baseline.cardinalities, key);
    const inCandidate = Object.prototype.hasOwnProperty.call(candidate.cardinalities, key);
    if (inBaseline && !inCandidate) {
      reasons.push(`Cardinality key "${key}" is missing from the candidate fixture.`);
      continue;
    }
    if (!inBaseline && inCandidate) {
      reasons.push(`Cardinality key "${key}" is extra in the candidate fixture.`);
      continue;
    }
    const baselineValue = baseline.cardinalities[key as keyof typeof baseline.cardinalities];
    const candidateValue = candidate.cardinalities[key as keyof typeof candidate.cardinalities];
    if (baselineValue !== candidateValue) {
      reasons.push(
        `Cardinality for "${key}" differs (baseline ${baselineValue} -> candidate ${candidateValue}).`,
      );
    }
  }

  return {
    hasFixtureMismatch: reasons.length > 0,
    fixtureMismatchReasons: reasons,
  };
}

// Reject comparisons across different projects, regions, or run configurations.
// Timings from mismatched environments or sample counts are not comparable.
function compareRunMetadata(
  baseline: Artifact,
  candidate: Artifact,
): { hasMetadataMismatch: boolean; metadataMismatchReasons: string[] } {
  const reasons: string[] = [];

  if (baseline.projectId !== candidate.projectId) {
    reasons.push(
      `Project ID differs (baseline ${baseline.projectId} -> candidate ${candidate.projectId}).`,
    );
  }
  if (baseline.regionId !== candidate.regionId) {
    reasons.push(
      `Region ID differs (baseline ${baseline.regionId} -> candidate ${candidate.regionId}).`,
    );
  }
  if (baseline.run.warmupCount !== candidate.run.warmupCount) {
    reasons.push(
      `Run warmup count differs (baseline ${baseline.run.warmupCount} -> candidate ${candidate.run.warmupCount}).`,
    );
  }
  if (baseline.run.repeatCount !== candidate.run.repeatCount) {
    reasons.push(
      `Run repeat count differs (baseline ${baseline.run.repeatCount} -> candidate ${candidate.run.repeatCount}).`,
    );
  }

  return {
    hasMetadataMismatch: reasons.length > 0,
    metadataMismatchReasons: reasons,
  };
}

function compareCase(
  name: string,
  baselineResult: QueryCaseResult | undefined,
  candidateResult: QueryCaseResult | undefined,
  thresholds: Thresholds,
): CaseComparison {
  if (!baselineResult && !candidateResult) {
    return {
      name, verdict: "unchanged", baseline: null, candidate: null,
      executionTimeDeltaPct: null, bufferReadDeltaPct: null, rowCountChanged: false, reasons: [],
    };
  }
  if (!baselineResult) {
    return {
      name, verdict: "missing-in-baseline", baseline: null, candidate: medianSample(candidateResult!.samples),
      executionTimeDeltaPct: null, bufferReadDeltaPct: null, rowCountChanged: false,
      reasons: ["Case exists only in the candidate artifact."],
    };
  }
  if (!candidateResult) {
    return {
      name, verdict: "missing-in-candidate", baseline: medianSample(baselineResult.samples), candidate: null,
      executionTimeDeltaPct: null, bufferReadDeltaPct: null, rowCountChanged: false,
      reasons: ["Case exists only in the baseline artifact."],
    };
  }

  const baseline = medianSample(baselineResult.samples);
  const candidate = medianSample(candidateResult.samples);
  const executionTimeDeltaPct = pctDelta(baseline.executionTimeMs, candidate.executionTimeMs);
  const bufferReadDeltaPct = pctDelta(baseline.sharedReadBlocks, candidate.sharedReadBlocks);
  const rowCountChanged = baseline.rootRows !== candidate.rootRows;

  const reasons: string[] = [];
  let regressed = false;
  const absoluteTimeDeltaMs = candidate.executionTimeMs - baseline.executionTimeMs;
  // A zero baseline time returns zero for another zero and no percentage otherwise.
  if (
    executionTimeDeltaPct !== null &&
    executionTimeDeltaPct > thresholds.timeRegressionPct &&
    absoluteTimeDeltaMs > thresholds.minAbsoluteMs
  ) {
    regressed = true;
    reasons.push(
      `Execution time regressed ${executionTimeDeltaPct.toFixed(1)}% (${baseline.executionTimeMs.toFixed(3)}ms -> ${candidate.executionTimeMs.toFixed(3)}ms).`,
    );
  }
  const absoluteBufferDelta = candidate.sharedReadBlocks - baseline.sharedReadBlocks;
  // Compare candidate reads to the absolute threshold when baseline reads are zero.
  const zeroBaselineBufferRegression =
    baseline.sharedReadBlocks === 0 && candidate.sharedReadBlocks > thresholds.minAbsoluteBlocks;
  if (
    zeroBaselineBufferRegression ||
    (bufferReadDeltaPct !== null &&
      bufferReadDeltaPct > thresholds.bufferRegressionPct &&
      absoluteBufferDelta > thresholds.minAbsoluteBlocks)
  ) {
    regressed = true;
    reasons.push(
      zeroBaselineBufferRegression
        ? `Shared buffer reads regressed from 0 to ${candidate.sharedReadBlocks} blocks (baseline was fully cached, so a percentage change is undefined).`
        : `Shared buffer reads regressed ${bufferReadDeltaPct!.toFixed(1)}% (${baseline.sharedReadBlocks} -> ${candidate.sharedReadBlocks} blocks).`,
    );
  }
  if (rowCountChanged) {
    reasons.push(`Root row count changed (${baseline.rootRows} -> ${candidate.rootRows}) — verify the candidate still returns equivalent results.`);
  }

  const improved = !regressed && executionTimeDeltaPct !== null && executionTimeDeltaPct < -thresholds.timeRegressionPct;
  const verdict: Verdict = regressed ? "regressed" : improved ? "improved" : "unchanged";
  return { name, verdict, baseline, candidate, executionTimeDeltaPct, bufferReadDeltaPct, rowCountChanged, reasons };
}

export function compareArtifacts(
  baseline: Artifact,
  candidate: Artifact,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): ComparisonReport {
  const { hasFixtureMismatch, fixtureMismatchReasons } = compareFixtureMetadata(
    baseline.fixture,
    candidate.fixture,
  );
  const { hasMetadataMismatch, metadataMismatchReasons } = compareRunMetadata(baseline, candidate);

  const baselineByName = new Map(baseline.results.map((result) => [result.name, result]));
  const candidateByName = new Map(candidate.results.map((result) => [result.name, result]));
  const names = [...new Set([...baselineByName.keys(), ...candidateByName.keys()])].sort();

  const cases = names.map((name) => compareCase(name, baselineByName.get(name), candidateByName.get(name), thresholds));
  const hasRegression = cases.some((entry) => entry.verdict === "regressed");
  // Candidate-only cases are allowed.
  const hasMissingCases = cases.some((entry) => entry.verdict === "missing-in-candidate");
  const hasRowCountChanges = cases.some((entry) => entry.rowCountChanged);
  return {
    createdAt: candidate.createdAt,
    baselineLabel: baseline.label,
    candidateLabel: candidate.label,
    thresholds,
    cases,
    hasRegression,
    hasMissingCases,
    hasRowCountChanges,
    hasFixtureMismatch,
    fixtureMismatchReasons,
    hasMetadataMismatch,
    metadataMismatchReasons,
    passed:
      !hasRegression &&
      !hasMissingCases &&
      !hasRowCountChanges &&
      !hasFixtureMismatch &&
      !hasMetadataMismatch,
  };
}
