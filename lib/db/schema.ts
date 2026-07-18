import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const monitorStates = [
  "PENDING",
  "UP",
  "VERIFYING_DOWN",
  "DOWN",
  "VERIFYING_UP",
  "PAUSED",
  "ARCHIVED",
] as const;

export const deviceAuthorizationStates = [
  "pending",
  "approved",
  "denied",
  "consumed",
  "expired",
] as const;

export const configOperationStates = [
  "written",
  "accepted",
  "rejected",
  "failed",
] as const;

export const notificationStatuses = [
  "pending",
  "sending",
  "sent",
  "failed",
  "dead",
] as const;

export const monitorRegistry = pgTable("monitor_registry", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  groupName: text("group_name"),
  enabled: boolean("enabled").notNull(),
  configHash: text("config_hash").notNull(),
  firstSeenAt: timestamptz("first_seen_at").notNull(),
  lastSeenAt: timestamptz("last_seen_at").notNull(),
  archivedAt: timestamptz("archived_at"),
}, (table) => [
  check(
    "monitor_registry_seen_order",
    sql`${table.lastSeenAt} >= ${table.firstSeenAt}`,
  ),
  check(
    "monitor_registry_archive_order",
    sql`${table.archivedAt} is null or ${table.archivedAt} >= ${table.firstSeenAt}`,
  ),
]);

export const monitoringConfigSnapshots = pgTable(
  "monitoring_config_snapshots",
  {
    id: uuid("id").primaryKey(),
    configVersion: integer("config_version").notNull(),
    configHash: text("config_hash").notNull(),
    configJson: jsonb("config_json").notNull(),
    status: text("status", { enum: ["accepted", "rejected"] }).notNull(),
    rejectionReason: text("rejection_reason"),
    source: text("source").notNull(),
    seenAt: timestamptz("seen_at").notNull(),
    acceptedAt: timestamptz("accepted_at"),
  },
  (table) => [
    check("monitoring_config_snapshots_version_nonnegative", sql`${table.configVersion} >= 0`),
    check(
      "monitoring_config_snapshots_status",
      sql`${table.status} in ('accepted', 'rejected')`,
    ),
    check(
      "monitoring_config_snapshots_outcome",
      sql`(${table.status} = 'accepted' and ${table.acceptedAt} is not null and ${table.rejectionReason} is null)
        or (${table.status} = 'rejected' and ${table.acceptedAt} is null and ${table.rejectionReason} is not null)`,
    ),
    check(
      "monitoring_config_snapshots_accepted_order",
      sql`${table.acceptedAt} is null or ${table.acceptedAt} >= ${table.seenAt}`,
    ),
  ],
);

export const configChangeApprovals = pgTable(
  "config_change_approvals",
  {
    id: uuid("id").primaryKey(),
    targetConfigHash: text("target_config_hash").notNull(),
    action: text("action", { enum: ["bulk_archive"] }).notNull(),
    createdByPrincipal: text("created_by_principal").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    consumedAt: timestamptz("consumed_at"),
  },
  (table) => [
    check("config_change_approvals_action", sql`${table.action} = 'bulk_archive'`),
    check("config_change_approvals_expiry_order", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "config_change_approvals_consumed_order",
      sql`${table.consumedAt} is null or ${table.consumedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const monitorState = pgTable("monitor_state", {
  monitorId: text("monitor_id")
    .primaryKey()
    .references(() => monitorRegistry.id),
  state: text("state", { enum: monitorStates }).notNull(),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  consecutiveSuccesses: integer("consecutive_successes").notNull().default(0),
  firstFailureAt: timestamptz("first_failure_at"),
  firstSuccessAt: timestamptz("first_success_at"),
  lastCheckedAt: timestamptz("last_checked_at"),
  lastSuccessAt: timestamptz("last_success_at"),
  lastFailureAt: timestamptz("last_failure_at"),
  lastStatusCode: integer("last_status_code"),
  lastLatencyMs: integer("last_latency_ms"),
  lastErrorCode: text("last_error_code"),
  activeIncidentId: uuid("active_incident_id"),
  version: integer("version").notNull().default(0),
  updatedAt: timestamptz("updated_at").notNull(),
}, (table) => [
  check(
    "monitor_state_state",
    sql`${table.state} in ('PENDING', 'UP', 'VERIFYING_DOWN', 'DOWN', 'VERIFYING_UP', 'PAUSED', 'ARCHIVED')`,
  ),
  check("monitor_state_failures_nonnegative", sql`${table.consecutiveFailures} >= 0`),
  check("monitor_state_successes_nonnegative", sql`${table.consecutiveSuccesses} >= 0`),
  check("monitor_state_latency_nonnegative", sql`${table.lastLatencyMs} is null or ${table.lastLatencyMs} >= 0`),
  check("monitor_state_version_nonnegative", sql`${table.version} >= 0`),
]);

export const checkResults = pgTable("check_results", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  monitorId: text("monitor_id").notNull().references(() => monitorRegistry.id),
  runId: uuid("run_id").notNull(),
  scheduledAt: timestamptz("scheduled_at").notNull(),
  checkedAt: timestamptz("checked_at").notNull(),
  successful: boolean("successful").notNull(),
  statusCode: integer("status_code"),
  latencyMs: integer("latency_ms").notNull(),
  effectiveUrl: text("effective_url"),
  redirectCount: integer("redirect_count").notNull().default(0),
  resolvedAddress: inet("resolved_address"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: timestamptz("created_at").notNull(),
}, (table) => [
  uniqueIndex("check_results_monitor_schedule").on(table.monitorId, table.scheduledAt),
  index("check_results_monitor_time").on(table.monitorId, table.checkedAt.desc()),
  index("check_results_retention").on(table.createdAt, table.id),
  check("check_results_latency_nonnegative", sql`${table.latencyMs} >= 0`),
  check("check_results_redirect_count", sql`${table.redirectCount} between 0 and 5`),
]);

export const incidents = pgTable("incidents", {
  id: uuid("id").primaryKey(),
  monitorId: text("monitor_id").notNull().references(() => monitorRegistry.id),
  openedAt: timestamptz("opened_at").notNull(),
  firstFailureAt: timestamptz("first_failure_at").notNull(),
  lastFailureAt: timestamptz("last_failure_at"),
  firstSuccessAt: timestamptz("first_success_at"),
  resolvedAt: timestamptz("resolved_at"),
  openingErrorCode: text("opening_error_code"),
  openingStatusCode: integer("opening_status_code"),
  resolutionReason: text("resolution_reason"),
  createdAt: timestamptz("created_at").notNull(),
  updatedAt: timestamptz("updated_at").notNull(),
}, (table) => [
  index("incidents_monitor_opened").on(table.monitorId, table.openedAt.desc()),
  uniqueIndex("incidents_one_active_per_monitor")
    .on(table.monitorId)
    .where(sql`${table.resolvedAt} is null`),
  check("incidents_opened_after_failure", sql`${table.openedAt} >= ${table.firstFailureAt}`),
  check("incidents_resolution_order", sql`${table.resolvedAt} is null or ${table.resolvedAt} >= ${table.openedAt}`),
  check(
    "incidents_resolution_start",
    sql`${table.resolvedAt} is null or (${table.firstSuccessAt} is not null and ${table.resolvedAt} = ${table.firstSuccessAt})`,
  ),
]);

export const notificationOutbox = pgTable("notification_outbox", {
  id: uuid("id").primaryKey(),
  incidentId: uuid("incident_id").references(() => incidents.id),
  monitorId: text("monitor_id").notNull().references(() => monitorRegistry.id),
  eventType: text("event_type").notNull(),
  recipient: text("recipient").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  payload: jsonb("payload").notNull(),
  status: text("status", { enum: notificationStatuses }).notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamptz("next_attempt_at").notNull(),
  claimToken: uuid("claim_token"),
  claimedAt: timestamptz("claimed_at"),
  providerMessageId: text("provider_message_id"),
  lastError: text("last_error"),
  sentAt: timestamptz("sent_at"),
  createdAt: timestamptz("created_at").notNull(),
  updatedAt: timestamptz("updated_at").notNull(),
}, (table) => [
  index("notification_outbox_due")
    .on(table.nextAttemptAt)
    .where(sql`${table.status} in ('pending', 'failed')`),
  index("notification_outbox_stale_claim")
    .on(table.claimedAt)
    .where(sql`${table.status} = 'sending'`),
  check("notification_outbox_status", sql`${table.status} in ('pending', 'sending', 'sent', 'failed', 'dead')`),
  check("notification_outbox_attempts_nonnegative", sql`${table.attemptCount} >= 0`),
  check(
    "notification_outbox_claim_pair",
    sql`(${table.claimToken} is null) = (${table.claimedAt} is null)`,
  ),
  check(
    "notification_outbox_sending_claim",
    sql`${table.status} <> 'sending' or (${table.claimToken} is not null and ${table.claimedAt} is not null)`,
  ),
  check(
    "notification_outbox_sent_timestamp",
    sql`${table.status} <> 'sent' or ${table.sentAt} is not null`,
  ),
]);

export const cronRuns = pgTable("cron_runs", {
  id: uuid("id").primaryKey(),
  jobName: text("job_name").notNull(),
  scheduledMinute: timestamptz("scheduled_minute").notNull(),
  status: text("status", { enum: ["running", "completed", "failed"] }).notNull(),
  startedAt: timestamptz("started_at").notNull(),
  completedAt: timestamptz("completed_at"),
  monitorCount: integer("monitor_count").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  errorMessage: text("error_message"),
}, (table) => [
  uniqueIndex("cron_runs_job_schedule").on(table.jobName, table.scheduledMinute),
  check("cron_runs_status", sql`${table.status} in ('running', 'completed', 'failed')`),
  check(
    "cron_runs_counts_nonnegative",
    sql`${table.monitorCount} >= 0 and ${table.successCount} >= 0 and ${table.failureCount} >= 0 and ${table.skippedCount} >= 0`,
  ),
  check("cron_runs_completion_order", sql`${table.completedAt} is null or ${table.completedAt} >= ${table.startedAt}`),
]);

export const jobLeases = pgTable("job_leases", {
  name: text("name").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  leaseUntil: timestamptz("lease_until").notNull(),
  updatedAt: timestamptz("updated_at").notNull(),
});

export const dailyRollups = pgTable("daily_rollups", {
  monitorId: text("monitor_id").notNull().references(() => monitorRegistry.id),
  day: date("day", { mode: "string" }).notNull(),
  totalChecks: integer("total_checks").notNull(),
  successfulChecks: integer("successful_checks").notNull(),
  failedChecks: integer("failed_checks").notNull(),
  uptimePercentage: numeric("uptime_percentage", { precision: 7, scale: 4 }),
  averageLatencyMs: integer("average_latency_ms"),
  p50LatencyMs: integer("p50_latency_ms"),
  p95LatencyMs: integer("p95_latency_ms"),
  incidentSeconds: integer("incident_seconds").notNull(),
}, (table) => [
  primaryKey({ columns: [table.monitorId, table.day] }),
  check(
    "daily_rollups_counts",
    sql`${table.totalChecks} >= 0 and ${table.successfulChecks} >= 0 and ${table.failedChecks} >= 0
      and ${table.totalChecks} = ${table.successfulChecks} + ${table.failedChecks}`,
  ),
  check(
    "daily_rollups_uptime_percentage",
    sql`${table.uptimePercentage} is null or ${table.uptimePercentage} between 0 and 100`,
  ),
  check(
    "daily_rollups_latency_nonnegative",
    sql`(${table.averageLatencyMs} is null or ${table.averageLatencyMs} >= 0)
      and (${table.p50LatencyMs} is null or ${table.p50LatencyMs} >= 0)
      and (${table.p95LatencyMs} is null or ${table.p95LatencyMs} >= 0)`,
  ),
  check("daily_rollups_incident_nonnegative", sql`${table.incidentSeconds} >= 0`),
]);

export const adminUsers = pgTable("admin_users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordDigest: text("password_digest").notNull(),
  createdAt: timestamptz("created_at").notNull(),
  updatedAt: timestamptz("updated_at").notNull(),
  passwordChangedAt: timestamptz("password_changed_at").notNull(),
  onboardingCompletedAt: timestamptz("onboarding_completed_at"),
}, (table) => [
  check("admin_users_normalized_email", sql`${table.email} = lower(btrim(${table.email}))`),
]);

export const humanSessions = pgTable("human_sessions", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => adminUsers.id),
  tokenDigest: bytea("token_digest").notNull().unique(),
  createdAt: timestamptz("created_at").notNull(),
  expiresAt: timestamptz("expires_at").notNull(),
  lastSeenAt: timestamptz("last_seen_at"),
  revokedAt: timestamptz("revoked_at"),
}, (table) => [
  check("human_sessions_expiry_order", sql`${table.expiresAt} > ${table.createdAt}`),
]);

export const onboardingProgress = pgTable("onboarding_progress", {
  userId: uuid("user_id").primaryKey().references(() => adminUsers.id),
  currentStep: text("current_step").notNull(),
  draftMonitor: jsonb("draft_monitor"),
  emailWarningAcknowledged: boolean("email_warning_acknowledged").notNull().default(false),
  updatedAt: timestamptz("updated_at").notNull(),
  completedAt: timestamptz("completed_at"),
});

export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  tokenPrefix: text("token_prefix").notNull(),
  tokenDigest: bytea("token_digest").notNull().unique(),
  principalType: text("principal_type").notNull(),
  principalId: text("principal_id").notNull(),
  scopes: text("scopes").array().notNull(),
  createdAt: timestamptz("created_at").notNull(),
  createdByPrincipal: text("created_by_principal").notNull(),
  expiresAt: timestamptz("expires_at").notNull(),
  lastUsedAt: timestamptz("last_used_at"),
  revokedAt: timestamptz("revoked_at"),
}, (table) => [
  check("api_tokens_expiry_order", sql`${table.expiresAt} > ${table.createdAt}`),
  check("api_tokens_expiry_limit", sql`${table.expiresAt} <= ${table.createdAt} + interval '365 days'`),
]);

export const cliInstallations = pgTable("cli_installations", {
  id: uuid("id").primaryKey(),
  installationKey: text("installation_key").notNull().unique(),
  userEmail: text("user_email").notNull(),
  displayName: text("display_name").notNull(),
  platform: text("platform").notNull(),
  architecture: text("architecture").notNull(),
  clientVersion: text("client_version").notNull(),
  createdAt: timestamptz("created_at").notNull(),
  linkedAt: timestamptz("linked_at").notNull(),
  lastSeenAt: timestamptz("last_seen_at"),
  revokedAt: timestamptz("revoked_at"),
}, (table) => [
  check("cli_installations_link_order", sql`${table.linkedAt} >= ${table.createdAt}`),
]);

export const cliSessions = pgTable("cli_sessions", {
  id: uuid("id").primaryKey(),
  installationId: uuid("installation_id").notNull().references(() => cliInstallations.id),
  tokenPrefix: text("token_prefix").notNull(),
  tokenDigest: bytea("token_digest").notNull().unique(),
  userEmail: text("user_email").notNull(),
  scopes: text("scopes").array().notNull(),
  createdAt: timestamptz("created_at").notNull(),
  expiresAt: timestamptz("expires_at").notNull(),
  lastUsedAt: timestamptz("last_used_at"),
  revokedAt: timestamptz("revoked_at"),
}, (table) => [
  check("cli_sessions_expiry_order", sql`${table.expiresAt} > ${table.createdAt}`),
]);

export const deviceAuthorizations = pgTable("device_authorizations", {
  id: uuid("id").primaryKey(),
  deviceCodeDigest: bytea("device_code_digest").notNull().unique(),
  userCode: text("user_code").notNull(),
  scopeProfile: text("scope_profile").notNull(),
  clientName: text("client_name").notNull(),
  installationKey: text("installation_key").notNull(),
  installationName: text("installation_name").notNull(),
  platform: text("platform").notNull(),
  architecture: text("architecture").notNull(),
  clientVersion: text("client_version").notNull(),
  state: text("state", { enum: deviceAuthorizationStates }).notNull(),
  createdAt: timestamptz("created_at").notNull(),
  expiresAt: timestamptz("expires_at").notNull(),
  pollingIntervalSeconds: integer("polling_interval_seconds").notNull(),
  lastPolledAt: timestamptz("last_polled_at"),
  pollCount: integer("poll_count").notNull().default(0),
  approvedByEmail: text("approved_by_email"),
  approvedAt: timestamptz("approved_at"),
  deniedAt: timestamptz("denied_at"),
  consumedAt: timestamptz("consumed_at"),
}, (table) => [
  uniqueIndex("device_authorizations_active_user_code")
    .on(sql`lower(${table.userCode})`)
    .where(sql`${table.state} in ('pending', 'approved')`),
  check("device_authorizations_state", sql`${table.state} in ('pending', 'approved', 'denied', 'consumed', 'expired')`),
  check("device_authorizations_expiry_order", sql`${table.expiresAt} > ${table.createdAt}`),
  check("device_authorizations_poll_interval", sql`${table.pollingIntervalSeconds} > 0`),
  check("device_authorizations_poll_count", sql`${table.pollCount} >= 0`),
]);

export const apiIdempotency = pgTable("api_idempotency", {
  id: uuid("id").primaryKey(),
  principalKey: text("principal_key").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  method: text("method").notNull(),
  routeKey: text("route_key").notNull(),
  requestHash: text("request_hash").notNull(),
  responseStatus: integer("response_status"),
  responseBody: jsonb("response_body"),
  state: text("state", { enum: ["running", "completed"] }).notNull(),
  createdAt: timestamptz("created_at").notNull(),
  completedAt: timestamptz("completed_at"),
  expiresAt: timestamptz("expires_at").notNull(),
}, (table) => [
  uniqueIndex("api_idempotency_principal_key").on(table.principalKey, table.idempotencyKey),
  index("api_idempotency_expiry").on(table.expiresAt),
  check("api_idempotency_state", sql`${table.state} in ('running', 'completed')`),
  check("api_idempotency_expiry_order", sql`${table.expiresAt} > ${table.createdAt}`),
  check(
    "api_idempotency_completion",
    sql`(${table.state} = 'running' and ${table.completedAt} is null)
      or (${table.state} = 'completed' and ${table.completedAt} is not null and ${table.responseStatus} is not null)`,
  ),
]);

export const apiRateLimitBuckets = pgTable("api_rate_limit_buckets", {
  principalKey: text("principal_key").notNull(),
  routeKey: text("route_key").notNull(),
  resourceKey: text("resource_key").notNull().default(""),
  windowStartedAt: timestamptz("window_started_at").notNull(),
  windowSeconds: integer("window_seconds").notNull(),
  requestCount: integer("request_count").notNull(),
  expiresAt: timestamptz("expires_at").notNull(),
}, (table) => [
  primaryKey({
    columns: [table.principalKey, table.routeKey, table.resourceKey, table.windowStartedAt],
  }),
  index("api_rate_limit_buckets_expiry").on(table.expiresAt),
  check("api_rate_limit_buckets_window", sql`${table.windowSeconds} > 0`),
  check("api_rate_limit_buckets_count", sql`${table.requestCount} >= 0`),
  check("api_rate_limit_buckets_expiry_order", sql`${table.expiresAt} > ${table.windowStartedAt}`),
]);

export const configOperations = pgTable("config_operations", {
  id: uuid("id").primaryKey(),
  principalKey: text("principal_key").notNull(),
  requestId: text("request_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  baseConfigHash: text("base_config_hash").notNull(),
  targetConfigHash: text("target_config_hash").notNull(),
  planHash: text("plan_hash").notNull(),
  desiredConfig: jsonb("desired_config").notNull(),
  diffJson: jsonb("diff_json").notNull(),
  state: text("state", { enum: configOperationStates }).notNull(),
  edgeConfigVersion: integer("edge_config_version"),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamptz("created_at").notNull(),
  writtenAt: timestamptz("written_at"),
  acceptedAt: timestamptz("accepted_at"),
  failedAt: timestamptz("failed_at"),
}, (table) => [
  index("config_operations_target_hash").on(table.targetConfigHash, table.state),
  check("config_operations_state", sql`${table.state} in ('written', 'accepted', 'rejected', 'failed')`),
  check("config_operations_edge_version", sql`${table.edgeConfigVersion} is null or ${table.edgeConfigVersion} >= 0`),
  check(
    "config_operations_timestamps",
    sql`(${table.writtenAt} is null or ${table.writtenAt} >= ${table.createdAt})
      and (${table.acceptedAt} is null or ${table.acceptedAt} >= ${table.createdAt})
      and (${table.failedAt} is null or ${table.failedAt} >= ${table.createdAt})`,
  ),
]);
