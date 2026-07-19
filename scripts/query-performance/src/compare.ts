// Deterministic comparison between two benchmark artifacts (baseline vs.
// candidate). Uses the median across repeats — not the mean — so a single GC
// pause or cold-cache blip in one sample can't flip a verdict. Thresholds are
// intentionally conservative (percentage AND absolute floor) so trivial
// sub-millisecond queries don't generate noise-driven regressions.

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
  // A case present in the baseline but absent from the candidate — a query
  // was removed or renamed without anyone noticing. Always a failure.
  hasMissingCases: boolean;
  // A case whose root row count changed between baseline and candidate —
  // the candidate may no longer be returning equivalent results. Always a
  // failure; the caller should look at each case's `rowCountChanged` flag
  // and verify manually before trusting the new query.
  hasRowCountChanges: boolean;
  // True only when none of the above are true. Prefer this over
  // re-deriving the same OR across hasRegression / hasMissingCases /
  // hasRowCountChanges at call sites.
  passed: boolean;
}

function pctDelta(baselineValue: number, candidateValue: number): number | null {
  if (baselineValue === 0) return candidateValue === 0 ? 0 : null;
  return ((candidateValue - baselineValue) / baselineValue) * 100;
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
  // Unlike sharedReadBlocks, a zero baseline here is not a realistic case
  // worth special-casing: Postgres's "Execution Time" in EXPLAIN (ANALYZE)
  // output is a wall-clock measurement with sub-millisecond floating-point
  // precision, so a real median across repeats is never exactly 0 — there
  // is no equivalent "fully warm, zero cost" state for elapsed time the way
  // there is for shared buffer reads.
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
  // pctDelta(0, N) is null for any N > 0 — a percentage regression is
  // undefined when the baseline did zero shared reads (fully warm cache).
  // Without this branch a baseline of 0 and a candidate of hundreds of
  // blocks would pass silently because bufferReadDeltaPct !== null never
  // holds. Fall back to an absolute-blocks comparison in that case.
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
  const baselineByName = new Map(baseline.results.map((result) => [result.name, result]));
  const candidateByName = new Map(candidate.results.map((result) => [result.name, result]));
  const names = [...new Set([...baselineByName.keys(), ...candidateByName.keys()])].sort();

  const cases = names.map((name) => compareCase(name, baselineByName.get(name), candidateByName.get(name), thresholds));
  const hasRegression = cases.some((entry) => entry.verdict === "regressed");
  // Deliberately excludes "missing-in-baseline" (a case newly added in the
  // candidate) — that's expected growth, not a failure.
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
    passed: !hasRegression && !hasMissingCases && !hasRowCountChanges,
  };
}
