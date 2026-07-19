// Runs the query inventory against the pinned temporary project.
// Writes a redacted artifact to an ignored directory.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { withConnection } from "./db-connection";
import { runQueryCase } from "./explain";
import { excludedQueries, queryCases } from "./query-cases";
import { loadSampleContext } from "./sample-context";
import type { Artifact } from "./artifact";
import { FIXTURE_VERSION } from "./fixture-constants";
import { verifyRetainedState, type RetainedStateProof } from "./verify-state";

const ARTIFACTS_DIR = resolve(import.meta.dirname, "..", "artifacts");

export interface RunBenchmarkOptions {
  label: string;
  warmupCount: number;
  repeatCount: number;
}

// Rejects benchmark runs when retained state does not match the recorded fixture.
export function assertBenchmarkableState(proof: RetainedStateProof): void {
  if (proof.fixtureVersion === null) {
    throw new Error("No fixture recorded in this temp project — run seed-fixture before running a benchmark.");
  }
  if (proof.fixtureVersion !== FIXTURE_VERSION) {
    throw new Error(
      `Fixture version ${proof.fixtureVersion} does not match this tool's expected ${FIXTURE_VERSION} — reseed before benchmarking.`,
    );
  }
  if (!proof.allMatch) {
    throw new Error("Retained-state verification found fixture row counts that don't match the recorded marker — reseed before benchmarking.");
  }
  if (!proof.allNonZero) {
    throw new Error("Retained-state verification found zero-row fixture tables — reseed before benchmarking.");
  }
  if (!proof.safeScope) {
    throw new Error("Retained-state verification found untagged monitor rows in scope — refusing to benchmark.");
  }
}

export async function runBenchmark(options: RunBenchmarkOptions): Promise<{ artifact: Artifact; artifactPath: string }> {
  const proof = await verifyRetainedState();
  assertBenchmarkableState(proof);
  const cardinalities = Object.fromEntries(
    proof.tables.map((entry) => [entry.table, entry.expected]),
  ) as unknown as Artifact["fixture"]["cardinalities"];

  const artifact = await withConnection(async (conn) => {
    const ctx = await loadSampleContext(conn);
    const results = [];
    for (const queryCase of queryCases) {
      results.push(await runQueryCase(conn, ctx, queryCase, {
        warmupCount: options.warmupCount,
        repeatCount: options.repeatCount,
      }));
    }

    const built: Artifact = {
      schemaVersion: 1,
      label: options.label,
      createdAt: new Date().toISOString(),
      projectId: conn.project.projectId,
      regionId: conn.project.regionId,
      fixture: { version: proof.fixtureVersion!, cardinalities },
      run: { warmupCount: options.warmupCount, repeatCount: options.repeatCount },
      results,
      excluded: excludedQueries,
    };
    return built;
  });

  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const fileName = `${options.label}-${artifact.createdAt.replace(/[:.]/g, "-")}.json`;
  const artifactPath = resolve(ARTIFACTS_DIR, fileName);
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + "\n", { mode: 0o600 });
  return { artifact, artifactPath };
}

// Accepts only positive integer sample counts.
function parsePositiveInt(raw: string | undefined, flagName: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Usage: --${flagName} must be a positive integer (got "${raw}").`);
  }
  return parsed;
}

export function parseArgs(argv: string[]): RunBenchmarkOptions {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-zA-Z-]+)=(.*)$/.exec(arg);
    if (match) flags.set(match[1]!, match[2]!);
  }
  return {
    label: flags.get("label") ?? "baseline",
    warmupCount: parsePositiveInt(flags.get("warmup"), "warmup", 2),
    repeatCount: parsePositiveInt(flags.get("repeat"), "repeat", 5),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { artifact, artifactPath } = await runBenchmark(options);
  console.log(`[run-benchmark] wrote ${artifact.results.length} case result(s) to ${artifactPath}`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((error) => {
    console.error("[run-benchmark] failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
