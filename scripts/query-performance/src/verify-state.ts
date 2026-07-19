// Verifies project identity, fixture cardinalities, and tag scope before benchmark
// results are trusted.

import { withConnection } from "./db-connection";
import { FIXTURE_VERSION, MONITOR_COUNT } from "./fixture-constants";
import type { FixtureCardinalities } from "./fixture-constants";

interface TableCheck {
  table: keyof FixtureCardinalities;
  countSql: string;
  taggedCountSql: string;
}

const TABLE_CHECKS: TableCheck[] = [
  { table: "monitor_registry", countSql: `select count(*)::int n from monitor_registry`, taggedCountSql: `select count(*)::int n from monitor_registry where id like 'qh-%'` },
  { table: "monitor_state", countSql: `select count(*)::int n from monitor_state where monitor_id like 'qh-%'`, taggedCountSql: `select count(*)::int n from monitor_state where monitor_id like 'qh-%'` },
  { table: "check_results", countSql: `select count(*)::int n from check_results where monitor_id like 'qh-%'`, taggedCountSql: `select count(*)::int n from check_results where monitor_id like 'qh-%'` },
  { table: "metric_rollups", countSql: `select count(*)::int n from metric_rollups where monitor_id like 'qh-%'`, taggedCountSql: `select count(*)::int n from metric_rollups where monitor_id like 'qh-%'` },
  { table: "daily_rollups", countSql: `select count(*)::int n from daily_rollups where monitor_id like 'qh-%'`, taggedCountSql: `select count(*)::int n from daily_rollups where monitor_id like 'qh-%'` },
  { table: "incidents", countSql: `select count(*)::int n from incidents where monitor_id like 'qh-%'`, taggedCountSql: `select count(*)::int n from incidents where monitor_id like 'qh-%'` },
  { table: "notification_outbox", countSql: `select count(*)::int n from notification_outbox where monitor_id like 'qh-%'`, taggedCountSql: `select count(*)::int n from notification_outbox where monitor_id like 'qh-%'` },
  { table: "monitoring_config_snapshots", countSql: `select count(*)::int n from monitoring_config_snapshots where source = 'qh-fixture'`, taggedCountSql: `select count(*)::int n from monitoring_config_snapshots where source = 'qh-fixture'` },
  { table: "config_change_approvals", countSql: `select count(*)::int n from config_change_approvals where created_by_principal = 'qh-fixture'`, taggedCountSql: `select count(*)::int n from config_change_approvals where created_by_principal = 'qh-fixture'` },
  { table: "config_operations", countSql: `select count(*)::int n from config_operations where principal_key = 'qh-fixture'`, taggedCountSql: `select count(*)::int n from config_operations where principal_key = 'qh-fixture'` },
  { table: "cron_runs", countSql: `select count(*)::int n from cron_runs where job_name like 'qh-%'`, taggedCountSql: `select count(*)::int n from cron_runs where job_name like 'qh-%'` },
  { table: "job_leases", countSql: `select count(*)::int n from job_leases where name like 'qh-%'`, taggedCountSql: `select count(*)::int n from job_leases where name like 'qh-%'` },
  { table: "check_batches", countSql: `select count(*)::int n from check_batches`, taggedCountSql: `select count(*)::int n from check_batches` },
  { table: "atomic_minute_commits", countSql: `select count(*)::int n from atomic_minute_commits`, taggedCountSql: `select count(*)::int n from atomic_minute_commits` },
  { table: "exception_payloads", countSql: `select count(*)::int n from exception_payloads`, taggedCountSql: `select count(*)::int n from exception_payloads` },
  { table: "monitor_exceptions", countSql: `select count(*)::int n from monitor_exceptions where monitor_id like 'qh-%'`, taggedCountSql: `select count(*)::int n from monitor_exceptions where monitor_id like 'qh-%'` },
  { table: "database_usage_snapshots", countSql: `select count(*)::int n from database_usage_snapshots`, taggedCountSql: `select count(*)::int n from database_usage_snapshots` },
  { table: "admin_users", countSql: `select count(*)::int n from admin_users where email like '%@qh-fixture.pulse-query-hillclimb.invalid'`, taggedCountSql: `select count(*)::int n from admin_users where email like '%@qh-fixture.pulse-query-hillclimb.invalid'` },
  { table: "human_sessions", countSql: `select count(*)::int n from human_sessions hs join admin_users au on au.id = hs.user_id where au.email like '%@qh-fixture.pulse-query-hillclimb.invalid'`, taggedCountSql: `select count(*)::int n from human_sessions hs join admin_users au on au.id = hs.user_id where au.email like '%@qh-fixture.pulse-query-hillclimb.invalid'` },
  { table: "onboarding_progress", countSql: `select count(*)::int n from onboarding_progress op join admin_users au on au.id = op.user_id where au.email like '%@qh-fixture.pulse-query-hillclimb.invalid'`, taggedCountSql: `select count(*)::int n from onboarding_progress op join admin_users au on au.id = op.user_id where au.email like '%@qh-fixture.pulse-query-hillclimb.invalid'` },
  { table: "api_tokens", countSql: `select count(*)::int n from api_tokens where name like 'qh-%'`, taggedCountSql: `select count(*)::int n from api_tokens where name like 'qh-%'` },
  { table: "cli_installations", countSql: `select count(*)::int n from cli_installations where installation_key like 'qh-%'`, taggedCountSql: `select count(*)::int n from cli_installations where installation_key like 'qh-%'` },
  { table: "cli_sessions", countSql: `select count(*)::int n from cli_sessions cs join cli_installations ci on ci.id = cs.installation_id where ci.installation_key like 'qh-%'`, taggedCountSql: `select count(*)::int n from cli_sessions cs join cli_installations ci on ci.id = cs.installation_id where ci.installation_key like 'qh-%'` },
  { table: "device_authorizations", countSql: `select count(*)::int n from device_authorizations where installation_key like 'qh-%'`, taggedCountSql: `select count(*)::int n from device_authorizations where installation_key like 'qh-%'` },
  { table: "api_idempotency", countSql: `select count(*)::int n from api_idempotency where principal_key = 'qh-fixture'`, taggedCountSql: `select count(*)::int n from api_idempotency where principal_key = 'qh-fixture'` },
  { table: "api_rate_limit_buckets", countSql: `select count(*)::int n from api_rate_limit_buckets where principal_key = 'qh-fixture'`, taggedCountSql: `select count(*)::int n from api_rate_limit_buckets where principal_key = 'qh-fixture'` },
];

// Count accepted snapshots outside fixture ownership.
export const ACCEPTED_CONFIG_NON_FIXTURE_RESIDUE_SQL =
  `select count(*)::int n from monitoring_config_snapshots where status = 'accepted' and source is distinct from 'qh-fixture'`;

export interface TableVerification {
  table: string;
  expected: number;
  actual: number;
  matches: boolean;
  nonZero: boolean;
}

export interface RetainedStateProof {
  projectId: string;
  regionId: string;
  fixtureVersion: number | null;
  seededAt: string | null;
  monitorCountExpected: number;
  monitorCountUntaggedResidue: number;
  acceptedConfigNonFixtureResidue: number;
  tables: TableVerification[];
  allMatch: boolean;
  allNonZero: boolean;
  safeScope: boolean;
}

// Safe scope excludes untagged monitors and non-fixture accepted snapshots.
export function evaluateSafeScope(input: {
  monitorCountUntaggedResidue: number;
  acceptedConfigNonFixtureResidue: number;
}): boolean {
  return input.monitorCountUntaggedResidue === 0
    && input.acceptedConfigNonFixtureResidue === 0;
}

// Apply the same proof gate as the CLI.
export function passesRetainedStateCliGate(proof: Pick<
  RetainedStateProof,
  "allMatch" | "allNonZero" | "safeScope" | "fixtureVersion"
>): boolean {
  return proof.allMatch
    && proof.allNonZero
    && proof.safeScope
    && proof.fixtureVersion === FIXTURE_VERSION;
}

export async function verifyRetainedState(): Promise<RetainedStateProof> {
  return withConnection(async (conn) => {
    // Drizzle installs its timestamp parser on the shared client. Raw timestamps
    // are read as strings and parsed locally.
    const [marker] = await conn.sql<Array<{ version: number; seeded_at: string; cardinalities: FixtureCardinalities }>>`
      select version, seeded_at, cardinalities from "_query_perf_fixture" where tag = 'qh-fixture'
    `;
    const expected = marker?.cardinalities ?? null;

    const tables: TableVerification[] = [];
    for (const check of TABLE_CHECKS) {
      const [row] = await conn.sql.unsafe<{ n: number }[]>(check.countSql);
      const actual = row?.n ?? 0;
      const expectedCount = expected ? expected[check.table] : 0;
      tables.push({
        table: check.table,
        expected: expectedCount,
        actual,
        matches: actual === expectedCount,
        nonZero: actual > 0,
      });
    }

    const [[untagged], [acceptedNonFixture]] = await Promise.all([
      conn.sql<Array<{ n: number }>>`select count(*)::int n from monitor_registry where id not like 'qh-%'`,
      conn.sql.unsafe<Array<{ n: number }>>(ACCEPTED_CONFIG_NON_FIXTURE_RESIDUE_SQL),
    ]);

    const monitorCountUntaggedResidue = untagged?.n ?? 0;
    const acceptedConfigNonFixtureResidue = acceptedNonFixture?.n ?? 0;

    return {
      projectId: conn.project.projectId,
      regionId: conn.project.regionId,
      fixtureVersion: marker?.version ?? null,
      seededAt: marker?.seeded_at ? new Date(marker.seeded_at).toISOString() : null,
      monitorCountExpected: MONITOR_COUNT,
      monitorCountUntaggedResidue,
      acceptedConfigNonFixtureResidue,
      tables,
      allMatch: tables.every((entry) => entry.matches),
      allNonZero: tables.every((entry) => entry.nonZero),
      safeScope: evaluateSafeScope({
        monitorCountUntaggedResidue,
        acceptedConfigNonFixtureResidue,
      }),
    };
  });
}

async function main() {
  const proof = await verifyRetainedState();
  console.log(JSON.stringify(proof, null, 2));
  if (!passesRetainedStateCliGate(proof)) {
    console.error("[verify-state] retained-state verification FAILED");
    process.exitCode = 1;
  } else {
    console.error("[verify-state] retained-state verification passed");
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((error) => {
    console.error("[verify-state] failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
