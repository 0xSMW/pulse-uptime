import { getTableName } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as schema from "./schema";

const tables = [
  schema.monitorRegistry,
  schema.monitoringConfigSnapshots,
  schema.configChangeApprovals,
  schema.monitorState,
  schema.checkResults,
  schema.incidents,
  schema.notificationOutbox,
  schema.cronRuns,
  schema.jobLeases,
  schema.checkBatches,
  schema.atomicMinuteCommits,
  schema.exceptionPayloads,
  schema.monitorExceptions,
  schema.metricRollups,
  schema.databaseUsageSnapshots,
  schema.adminUsers,
  schema.humanSessions,
  schema.onboardingProgress,
  schema.apiTokens,
  schema.cliInstallations,
  schema.cliSessions,
  schema.deviceAuthorizations,
  schema.apiIdempotency,
  schema.apiRateLimitBuckets,
  schema.configOperations,
] satisfies PgTable[];

const expectedTableNames = [
  "admin_users",
  "api_idempotency",
  "api_rate_limit_buckets",
  "api_tokens",
  "atomic_minute_commits",
  "check_batches",
  "check_results",
  "cli_installations",
  "cli_sessions",
  "config_change_approvals",
  "config_operations",
  "cron_runs",
  "database_usage_snapshots",
  "device_authorizations",
  "exception_payloads",
  "human_sessions",
  "incidents",
  "job_leases",
  "metric_rollups",
  "monitor_exceptions",
  "monitor_registry",
  "monitor_state",
  "monitoring_config_snapshots",
  "notification_outbox",
  "onboarding_progress",
];

const requiredIndexes = [
  "api_idempotency_expiry",
  "api_idempotency_principal_key",
  "api_rate_limit_buckets_expiry",
  "api_tokens_active_creator",
  "check_results_monitor_schedule",
  "check_results_monitor_time",
  "check_results_retention",
  "cli_sessions_installation",
  "config_operations_principal_idempotency",
  "config_operations_target_hash",
  "cron_runs_job_release_completed",
  "cron_runs_job_schedule",
  "device_authorizations_active_user_code",
  "exception_payloads_retention",
  "incidents_feed_order",
  "incidents_monitor_opened",
  "incidents_one_active_per_monitor",
  "metric_rollups_retention",
  "monitor_exceptions_identity",
  "monitor_exceptions_incident",
  "monitor_exceptions_retention",
  "monitoring_config_snapshots_accepted_order",
  "notification_outbox_due",
  "notification_outbox_incident",
  "notification_outbox_stale_claim",
];

describe("database schema", () => {
  it("defines every table in the database contract", () => {
    expect(tables.map(getTableName).sort()).toEqual(expectedTableNames);
  });

  it("uses timestamptz for every timestamp", () => {
    const timestampColumns = tables.flatMap((table) =>
      getTableConfig(table).columns.filter((column) =>
        column.getSQLType().startsWith("timestamp"),
      ),
    );

    expect(timestampColumns.length).toBeGreaterThan(0);
    expect(timestampColumns.map((column) => column.getSQLType()))
      .toEqual(timestampColumns.map(() => "timestamp with time zone"));
  });

  it("defines every required reliability index", () => {
    const indexes = tables
      .flatMap((table) => getTableConfig(table).indexes)
      .map((index) => index.config.name)
      .sort();

    expect(indexes).toEqual(requiredIndexes);
  });

  it("keeps the reliability indexes unique or partial where required", () => {
    const indexes = new Map(
      tables
        .flatMap((table) => getTableConfig(table).indexes)
        .map((index) => [index.config.name, index.config]),
    );

    expect(indexes.get("check_results_monitor_schedule")?.unique).toBe(true);
    expect(indexes.get("incidents_one_active_per_monitor")?.unique).toBe(true);
    expect(indexes.get("incidents_one_active_per_monitor")?.where).toBeDefined();
    expect(indexes.get("cron_runs_job_schedule")?.unique).toBe(true);
    expect(indexes.get("cron_runs_job_release_completed")?.where).toBeDefined();
    expect(indexes.get("api_idempotency_principal_key")?.unique).toBe(true);
    expect(indexes.get("device_authorizations_active_user_code")?.unique).toBe(true);
    expect(indexes.get("device_authorizations_active_user_code")?.where).toBeDefined();
    expect(indexes.get("notification_outbox_due")?.where).toBeDefined();
    expect(indexes.get("notification_outbox_stale_claim")?.where).toBeDefined();
    expect(indexes.get("notification_outbox_incident")?.where).toBeDefined();
    expect(indexes.get("monitoring_config_snapshots_accepted_order")?.where).toBeDefined();
    expect(indexes.get("api_tokens_active_creator")?.where).toBeDefined();
    expect(indexes.get("config_operations_principal_idempotency")?.unique).toBe(false);
  });

  it("enforces the documented state domains", () => {
    const checkNames = tables.flatMap((table) =>
      getTableConfig(table).checks.map((constraint) => constraint.name),
    );

    expect(checkNames).toEqual(expect.arrayContaining([
      "api_idempotency_state",
      "config_change_approvals_action",
      "config_operations_state",
      "cron_runs_release_id",
      "cron_runs_status",
      "device_authorizations_state",
      "monitor_state_state",
      "monitoring_config_snapshots_status",
      "notification_outbox_status",
    ]));
  });
});
