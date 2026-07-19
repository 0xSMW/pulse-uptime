// Validates query builders, SQL placeholders, and fixture cardinalities without
// a network connection. The lazy Postgres client only uses `.toSQL()` against
// an unroutable address. Ambient database environment access is rejected.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

import * as schema from "../../../lib/db/schema";
import { excludedQueries, queryCases } from "./query-cases";
import type { GatedConnection } from "./db-connection";
import type { TempProjectState } from "./local-state";
import type { SampleContext } from "./sample-context";

const FAKE_PROJECT_STATE: TempProjectState = {
  marker: "query-performance-temp-project",
  projectId: "validate-only-never-connects",
  projectName: "validate-only-never-connects",
  regionId: "none",
  createdAt: new Date(0).toISOString(),
  database: "validate-never-connects",
  role: "validate",
  host: "0.0.0.0",
};

const FAKE_SAMPLE_CONTEXT: SampleContext = {
  now: new Date("2026-01-01T00:00:00Z"),
  monitorIds: Array.from({ length: 10 }, (_, index) => `qh-monitor-${String(index + 1).padStart(4, "0")}`),
  groupSlug: "api",
  incidentIds: [
    "00000000-0000-0000-0000-000000000001",
    "00000000-0000-0000-0000-000000000002",
    "00000000-0000-0000-0000-000000000003",
  ],
  ongoingIncidentId: "00000000-0000-0000-0000-000000000001",
  resolvedIncidentId: "00000000-0000-0000-0000-000000000002",
  incidentMonitorId: "qh-monitor-0001",
};

function countPlaceholders(text: string): number {
  const matches = text.match(/\$\d+/g) ?? [];
  return matches.length === 0 ? 0 : Math.max(...matches.map((match) => Number(match.slice(1))));
}

export interface ValidationIssue {
  scope: string;
  message: string;
}

export interface ValidationReport {
  queryCaseCount: number;
  excludedQueryCount: number;
  issues: ValidationIssue[];
  ok: boolean;
}

export function validateInventoryStatically(): ValidationReport {
  const issues: ValidationIssue[] = [];

  const names = new Set<string>();
  for (const queryCase of queryCases) {
    if (names.has(queryCase.name)) issues.push({ scope: queryCase.name, message: "Duplicate query case name." });
    names.add(queryCase.name);
    if (!queryCase.description.trim()) issues.push({ scope: queryCase.name, message: "Missing description." });
    if (!queryCase.source.trim()) issues.push({ scope: queryCase.name, message: "Missing source pointer." });
  }
  for (const excluded of excludedQueries) {
    if (names.has(excluded.name)) issues.push({ scope: excluded.name, message: "Excluded query name collides with an included query case." });
    if (!excluded.reason.trim()) issues.push({ scope: excluded.name, message: "Excluded query is missing an exclusion reason." });
    if (!excluded.source.trim()) issues.push({ scope: excluded.name, message: "Excluded query is missing a source pointer." });
  }

  // Build SQL through a lazy client bound to an unroutable address.
  const sql = postgres("postgres://validate:validate@0.0.0.0:1/validate-never-connects", { max: 1 });
  const db = drizzle(sql, { schema });
  const fakeConn: GatedConnection = { project: FAKE_PROJECT_STATE, sql, db };

  for (const queryCase of queryCases) {
    try {
      const built = queryCase.build(fakeConn, FAKE_SAMPLE_CONTEXT);
      if (!built.text.trim()) {
        issues.push({ scope: queryCase.name, message: "Built query has empty SQL text." });
        continue;
      }
      const maxPlaceholder = countPlaceholders(built.text);
      if (maxPlaceholder > built.params.length) {
        issues.push({
          scope: queryCase.name,
          message: `Query text references $${maxPlaceholder} but only ${built.params.length} params were provided.`,
        });
      }
    } catch (error) {
      issues.push({ scope: queryCase.name, message: `Failed to build query statically: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  issues.push(...scanForForbiddenEnvUsage());

  return { queryCaseCount: queryCases.length, excludedQueryCount: excludedQueries.length, issues, ok: issues.length === 0 };
}

const FORBIDDEN_PATTERNS = [/process\.env\.DATABASE_URL/, /process\.env\.PGHOST/, /process\.env\.PGPASSWORD/];

// Strip comments so prose does not trigger forbidden environment checks.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function scanForForbiddenEnvUsage(): ValidationIssue[] {
  const srcDir = resolve(import.meta.dirname);
  const issues: ValidationIssue[] = [];
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const contents = stripComments(readFileSync(resolve(srcDir, entry.name), "utf8"));
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(contents)) {
        issues.push({ scope: entry.name, message: `File matches forbidden pattern ${pattern} — this tool must never read ambient DB env vars.` });
      }
    }
  }
  return issues;
}

async function main() {
  const report = validateInventoryStatically();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.error(`[validate] ${report.issues.length} issue(s) found.`);
    process.exitCode = 1;
  } else {
    console.error(`[validate] ${report.queryCaseCount} query case(s) and ${report.excludedQueryCount} excluded entries validated statically — no connection opened.`);
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((error) => {
    console.error("[validate] failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
