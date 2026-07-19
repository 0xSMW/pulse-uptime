import { describe, expect, it } from "vitest";

import { assertBenchmarkableState, parseArgs } from "../src/run-benchmark";
import { FIXTURE_VERSION } from "../src/fixture-constants";
import type { RetainedStateProof } from "../src/verify-state";

function validProof(overrides: Partial<RetainedStateProof> = {}): RetainedStateProof {
  return {
    projectId: "fake-project",
    regionId: "fake-region",
    fixtureVersion: FIXTURE_VERSION,
    seededAt: new Date(0).toISOString(),
    monitorCountExpected: 100,
    monitorCountUntaggedResidue: 0,
    tables: [{ table: "monitor_registry", expected: 100, actual: 100, matches: true, nonZero: true }],
    allMatch: true,
    allNonZero: true,
    safeScope: true,
    ...overrides,
  };
}

describe("assertBenchmarkableState", () => {
  it("does not throw for a fully verified fixture at the current version", () => {
    expect(() => assertBenchmarkableState(validProof())).not.toThrow();
  });

  it("refuses when no marker was ever recorded", () => {
    expect(() => assertBenchmarkableState(validProof({ fixtureVersion: null }))).toThrow(/run seed-fixture/i);
  });

  it("refuses when the recorded fixture version does not match this tool's expected version", () => {
    expect(() => assertBenchmarkableState(validProof({ fixtureVersion: FIXTURE_VERSION + 1 }))).toThrow(/does not match/i);
  });

  it("refuses when a table's row count doesn't match the recorded marker (a partial reseed left stale or half-written data)", () => {
    const proof = validProof({
      allMatch: false,
      tables: [{ table: "monitor_registry", expected: 100, actual: 37, matches: false, nonZero: true }],
    });
    expect(() => assertBenchmarkableState(proof)).toThrow(/row counts/i);
  });

  it("refuses when a fixture table is unexpectedly empty", () => {
    const proof = validProof({
      allNonZero: false,
      tables: [{ table: "monitor_registry", expected: 100, actual: 0, matches: false, nonZero: false }],
    });
    expect(() => assertBenchmarkableState(proof)).toThrow(/zero-row/i);
  });

  it("refuses when untagged rows are in scope (reset could touch data outside the fixture tag)", () => {
    const proof = validProof({ safeScope: false, monitorCountUntaggedResidue: 3 });
    expect(() => assertBenchmarkableState(proof)).toThrow(/untagged/i);
  });
});

describe("parseArgs", () => {
  it("defaults warmup to 2 and repeat to 5 when unset", () => {
    const options = parseArgs([]);
    expect(options).toEqual({ label: "baseline", warmupCount: 2, repeatCount: 5 });
  });

  it("accepts explicit positive integers for warmup and repeat", () => {
    const options = parseArgs(["--warmup=3", "--repeat=10", "--label=candidate"]);
    expect(options).toEqual({ label: "candidate", warmupCount: 3, repeatCount: 10 });
  });

  it("rejects --warmup=0", () => {
    expect(() => parseArgs(["--warmup=0"])).toThrow(/warmup must be a positive integer/i);
  });

  it("rejects a negative --repeat", () => {
    expect(() => parseArgs(["--repeat=-1"])).toThrow(/repeat must be a positive integer/i);
  });

  it("rejects a non-numeric --warmup (NaN)", () => {
    expect(() => parseArgs(["--warmup=nope"])).toThrow(/warmup must be a positive integer/i);
  });

  it("rejects a non-integer --repeat", () => {
    expect(() => parseArgs(["--repeat=2.5"])).toThrow(/repeat must be a positive integer/i);
  });

  it("rejects an empty --warmup value", () => {
    expect(() => parseArgs(["--warmup="])).toThrow(/warmup must be a positive integer/i);
  });
});
