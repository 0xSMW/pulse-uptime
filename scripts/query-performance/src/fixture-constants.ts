// Shared constants describing the tagged fixture. Every identifier the
// fixture creates is namespaced under "qh-" (or the ".invalid"/".pulse-query-
// hillclimb.invalid" fixture domains below) so it can be selected, reset, and
// verified without touching anything else that might exist in the temp
// project, and so nothing here can ever be mistaken for a real account,
// domain, or token.

export const FIXTURE_TAG = "qh";
// Bump whenever a fixtures.ts change alters seeded row shape or cardinality
// (e.g. v2: ROLLUP_15M_DAYS 2 -> 8 to match production's 7-day monitor-detail
// rollup window) so a stale, differently-shaped fixture is rejected by
// run-benchmark's version check instead of silently benchmarked against.
export const FIXTURE_VERSION = 2;
export const MONITOR_COUNT = 100;
export const FIXTURE_EMAIL_DOMAIN = "qh-fixture.pulse-query-hillclimb.invalid";
export const FIXTURE_URL_DOMAIN = "example.invalid";

export function monitorId(index: number): string {
  return `qh-monitor-${String(index).padStart(4, "0")}`;
}

export function isFixtureMonitorId(id: string): boolean {
  return id.startsWith("qh-monitor-");
}

export const GROUP_NAMES = ["API", "Web", "Database", "Payments", "Internal Tools"] as const;

export const monitorStateDistribution = [
  { state: "UP", count: 70 },
  { state: "DOWN", count: 10 },
  { state: "VERIFYING_DOWN", count: 5 },
  { state: "VERIFYING_UP", count: 5 },
  { state: "PENDING", count: 5 },
  { state: "PAUSED", count: 3 },
  { state: "ARCHIVED", count: 2 },
] as const;

export interface FixtureCardinalities {
  monitor_registry: number;
  monitor_state: number;
  check_results: number;
  metric_rollups: number;
  daily_rollups: number;
  incidents: number;
  notification_outbox: number;
  monitoring_config_snapshots: number;
  config_change_approvals: number;
  config_operations: number;
  cron_runs: number;
  job_leases: number;
  check_batches: number;
  atomic_minute_commits: number;
  exception_payloads: number;
  monitor_exceptions: number;
  database_usage_snapshots: number;
  admin_users: number;
  human_sessions: number;
  onboarding_progress: number;
  api_tokens: number;
  cli_installations: number;
  cli_sessions: number;
  device_authorizations: number;
  api_idempotency: number;
  api_rate_limit_buckets: number;
}
