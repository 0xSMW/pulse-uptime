import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Artifact } from "./artifact";
import { compareArtifacts, DEFAULT_THRESHOLDS } from "./compare";

function parseArgs(argv: string[]): { baseline: string; candidate: string } {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-zA-Z-]+)=(.*)$/.exec(arg);
    if (match) flags.set(match[1]!, match[2]!);
  }
  const baseline = flags.get("baseline");
  const candidate = flags.get("candidate");
  if (!baseline || !candidate) {
    throw new Error("Usage: compare-artifacts --baseline=<path> --candidate=<path>");
  }
  return { baseline, candidate };
}

function loadArtifact(path: string): Artifact {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as Artifact;
}

async function main() {
  const { baseline, candidate } = parseArgs(process.argv.slice(2));
  const report = compareArtifacts(loadArtifact(baseline), loadArtifact(candidate), DEFAULT_THRESHOLDS);
  console.log(JSON.stringify(report, null, 2));
  if (report.hasRegression) {
    console.error("[compare-artifacts] regression(s) detected — see reasons above.");
    process.exitCode = 1;
  } else {
    console.error("[compare-artifacts] no regressions detected.");
  }
}

main().catch((error) => {
  console.error("[compare-artifacts] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
