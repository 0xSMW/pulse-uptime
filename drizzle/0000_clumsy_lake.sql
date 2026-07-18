CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_digest" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"password_changed_at" timestamp with time zone NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	CONSTRAINT "admin_users_email_unique" UNIQUE("email"),
	CONSTRAINT "admin_users_normalized_email" CHECK ("admin_users"."email" = lower(btrim("admin_users"."email")))
);
--> statement-breakpoint
CREATE TABLE "api_idempotency" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_key" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"method" text NOT NULL,
	"route_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_idempotency_state" CHECK ("api_idempotency"."state" in ('running', 'completed')),
	CONSTRAINT "api_idempotency_expiry_order" CHECK ("api_idempotency"."expires_at" > "api_idempotency"."created_at"),
	CONSTRAINT "api_idempotency_completion" CHECK (("api_idempotency"."state" = 'running' and "api_idempotency"."completed_at" is null)
      or ("api_idempotency"."state" = 'completed' and "api_idempotency"."completed_at" is not null and "api_idempotency"."response_status" is not null))
);
--> statement-breakpoint
CREATE TABLE "api_rate_limit_buckets" (
	"principal_key" text NOT NULL,
	"route_key" text NOT NULL,
	"resource_key" text DEFAULT '' NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"window_seconds" integer NOT NULL,
	"request_count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_rate_limit_buckets_principal_key_route_key_resource_key_window_started_at_pk" PRIMARY KEY("principal_key","route_key","resource_key","window_started_at"),
	CONSTRAINT "api_rate_limit_buckets_window" CHECK ("api_rate_limit_buckets"."window_seconds" > 0),
	CONSTRAINT "api_rate_limit_buckets_count" CHECK ("api_rate_limit_buckets"."request_count" >= 0),
	CONSTRAINT "api_rate_limit_buckets_expiry_order" CHECK ("api_rate_limit_buckets"."expires_at" > "api_rate_limit_buckets"."window_started_at")
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_digest" "bytea" NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by_principal" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_tokens_token_digest_unique" UNIQUE("token_digest"),
	CONSTRAINT "api_tokens_expiry_order" CHECK ("api_tokens"."expires_at" > "api_tokens"."created_at"),
	CONSTRAINT "api_tokens_expiry_limit" CHECK ("api_tokens"."expires_at" <= "api_tokens"."created_at" + interval '365 days')
);
--> statement-breakpoint
CREATE TABLE "check_results" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "check_results_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"monitor_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"successful" boolean NOT NULL,
	"status_code" integer,
	"latency_ms" integer NOT NULL,
	"effective_url" text,
	"redirect_count" integer DEFAULT 0 NOT NULL,
	"resolved_address" "inet",
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "check_results_latency_nonnegative" CHECK ("check_results"."latency_ms" >= 0),
	CONSTRAINT "check_results_redirect_count" CHECK ("check_results"."redirect_count" between 0 and 5)
);
--> statement-breakpoint
CREATE TABLE "cli_installations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"installation_key" text NOT NULL,
	"user_email" text NOT NULL,
	"display_name" text NOT NULL,
	"platform" text NOT NULL,
	"architecture" text NOT NULL,
	"client_version" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "cli_installations_installation_key_unique" UNIQUE("installation_key"),
	CONSTRAINT "cli_installations_link_order" CHECK ("cli_installations"."linked_at" >= "cli_installations"."created_at")
);
--> statement-breakpoint
CREATE TABLE "cli_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"installation_id" uuid NOT NULL,
	"token_prefix" text NOT NULL,
	"token_digest" "bytea" NOT NULL,
	"user_email" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "cli_sessions_token_digest_unique" UNIQUE("token_digest"),
	CONSTRAINT "cli_sessions_expiry_order" CHECK ("cli_sessions"."expires_at" > "cli_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "config_change_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_config_hash" text NOT NULL,
	"action" text NOT NULL,
	"created_by_principal" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "config_change_approvals_action" CHECK ("config_change_approvals"."action" = 'bulk_archive'),
	CONSTRAINT "config_change_approvals_expiry_order" CHECK ("config_change_approvals"."expires_at" > "config_change_approvals"."created_at"),
	CONSTRAINT "config_change_approvals_consumed_order" CHECK ("config_change_approvals"."consumed_at" is null or "config_change_approvals"."consumed_at" >= "config_change_approvals"."created_at")
);
--> statement-breakpoint
CREATE TABLE "config_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_key" text NOT NULL,
	"request_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"base_config_hash" text NOT NULL,
	"target_config_hash" text NOT NULL,
	"plan_hash" text NOT NULL,
	"desired_config" jsonb NOT NULL,
	"diff_json" jsonb NOT NULL,
	"state" text NOT NULL,
	"edge_config_version" integer,
	"rejection_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"written_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	CONSTRAINT "config_operations_state" CHECK ("config_operations"."state" in ('written', 'accepted', 'rejected', 'failed')),
	CONSTRAINT "config_operations_edge_version" CHECK ("config_operations"."edge_config_version" is null or "config_operations"."edge_config_version" >= 0),
	CONSTRAINT "config_operations_timestamps" CHECK (("config_operations"."written_at" is null or "config_operations"."written_at" >= "config_operations"."created_at")
      and ("config_operations"."accepted_at" is null or "config_operations"."accepted_at" >= "config_operations"."created_at")
      and ("config_operations"."failed_at" is null or "config_operations"."failed_at" >= "config_operations"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "cron_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_name" text NOT NULL,
	"scheduled_minute" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"monitor_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	CONSTRAINT "cron_runs_status" CHECK ("cron_runs"."status" in ('running', 'completed', 'failed')),
	CONSTRAINT "cron_runs_counts_nonnegative" CHECK ("cron_runs"."monitor_count" >= 0 and "cron_runs"."success_count" >= 0 and "cron_runs"."failure_count" >= 0 and "cron_runs"."skipped_count" >= 0),
	CONSTRAINT "cron_runs_completion_order" CHECK ("cron_runs"."completed_at" is null or "cron_runs"."completed_at" >= "cron_runs"."started_at")
);
--> statement-breakpoint
CREATE TABLE "daily_rollups" (
	"monitor_id" text NOT NULL,
	"day" date NOT NULL,
	"total_checks" integer NOT NULL,
	"successful_checks" integer NOT NULL,
	"failed_checks" integer NOT NULL,
	"uptime_percentage" numeric(7, 4),
	"average_latency_ms" integer,
	"p50_latency_ms" integer,
	"p95_latency_ms" integer,
	"incident_seconds" integer NOT NULL,
	CONSTRAINT "daily_rollups_monitor_id_day_pk" PRIMARY KEY("monitor_id","day"),
	CONSTRAINT "daily_rollups_counts" CHECK ("daily_rollups"."total_checks" >= 0 and "daily_rollups"."successful_checks" >= 0 and "daily_rollups"."failed_checks" >= 0
      and "daily_rollups"."total_checks" = "daily_rollups"."successful_checks" + "daily_rollups"."failed_checks"),
	CONSTRAINT "daily_rollups_uptime_percentage" CHECK ("daily_rollups"."uptime_percentage" is null or "daily_rollups"."uptime_percentage" between 0 and 100),
	CONSTRAINT "daily_rollups_latency_nonnegative" CHECK (("daily_rollups"."average_latency_ms" is null or "daily_rollups"."average_latency_ms" >= 0)
      and ("daily_rollups"."p50_latency_ms" is null or "daily_rollups"."p50_latency_ms" >= 0)
      and ("daily_rollups"."p95_latency_ms" is null or "daily_rollups"."p95_latency_ms" >= 0)),
	CONSTRAINT "daily_rollups_incident_nonnegative" CHECK ("daily_rollups"."incident_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "device_authorizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_code_digest" "bytea" NOT NULL,
	"user_code" text NOT NULL,
	"scope_profile" text NOT NULL,
	"client_name" text NOT NULL,
	"installation_key" text NOT NULL,
	"installation_name" text NOT NULL,
	"platform" text NOT NULL,
	"architecture" text NOT NULL,
	"client_version" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"polling_interval_seconds" integer NOT NULL,
	"last_polled_at" timestamp with time zone,
	"poll_count" integer DEFAULT 0 NOT NULL,
	"approved_by_email" text,
	"approved_at" timestamp with time zone,
	"denied_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "device_authorizations_device_code_digest_unique" UNIQUE("device_code_digest"),
	CONSTRAINT "device_authorizations_state" CHECK ("device_authorizations"."state" in ('pending', 'approved', 'denied', 'consumed', 'expired')),
	CONSTRAINT "device_authorizations_expiry_order" CHECK ("device_authorizations"."expires_at" > "device_authorizations"."created_at"),
	CONSTRAINT "device_authorizations_poll_interval" CHECK ("device_authorizations"."polling_interval_seconds" > 0),
	CONSTRAINT "device_authorizations_poll_count" CHECK ("device_authorizations"."poll_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "human_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_digest" "bytea" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "human_sessions_token_digest_unique" UNIQUE("token_digest"),
	CONSTRAINT "human_sessions_expiry_order" CHECK ("human_sessions"."expires_at" > "human_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"monitor_id" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"first_failure_at" timestamp with time zone NOT NULL,
	"last_failure_at" timestamp with time zone,
	"first_success_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"opening_error_code" text,
	"opening_status_code" integer,
	"resolution_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "incidents_opened_after_failure" CHECK ("incidents"."opened_at" >= "incidents"."first_failure_at"),
	CONSTRAINT "incidents_resolution_order" CHECK ("incidents"."resolved_at" is null or "incidents"."resolved_at" >= "incidents"."opened_at"),
	CONSTRAINT "incidents_resolution_start" CHECK ("incidents"."resolved_at" is null or ("incidents"."first_success_at" is not null and "incidents"."resolved_at" = "incidents"."first_success_at"))
);
--> statement-breakpoint
CREATE TABLE "job_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor_registry" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"group_name" text,
	"enabled" boolean NOT NULL,
	"config_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "monitor_registry_seen_order" CHECK ("monitor_registry"."last_seen_at" >= "monitor_registry"."first_seen_at"),
	CONSTRAINT "monitor_registry_archive_order" CHECK ("monitor_registry"."archived_at" is null or "monitor_registry"."archived_at" >= "monitor_registry"."first_seen_at")
);
--> statement-breakpoint
CREATE TABLE "monitor_state" (
	"monitor_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"consecutive_successes" integer DEFAULT 0 NOT NULL,
	"first_failure_at" timestamp with time zone,
	"first_success_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_status_code" integer,
	"last_latency_ms" integer,
	"last_error_code" text,
	"active_incident_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "monitor_state_state" CHECK ("monitor_state"."state" in ('PENDING', 'UP', 'VERIFYING_DOWN', 'DOWN', 'VERIFYING_UP', 'PAUSED', 'ARCHIVED')),
	CONSTRAINT "monitor_state_failures_nonnegative" CHECK ("monitor_state"."consecutive_failures" >= 0),
	CONSTRAINT "monitor_state_successes_nonnegative" CHECK ("monitor_state"."consecutive_successes" >= 0),
	CONSTRAINT "monitor_state_latency_nonnegative" CHECK ("monitor_state"."last_latency_ms" is null or "monitor_state"."last_latency_ms" >= 0),
	CONSTRAINT "monitor_state_version_nonnegative" CHECK ("monitor_state"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "monitoring_config_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"config_version" integer NOT NULL,
	"config_hash" text NOT NULL,
	"config_json" jsonb NOT NULL,
	"status" text NOT NULL,
	"rejection_reason" text,
	"source" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "monitoring_config_snapshots_version_nonnegative" CHECK ("monitoring_config_snapshots"."config_version" >= 0),
	CONSTRAINT "monitoring_config_snapshots_status" CHECK ("monitoring_config_snapshots"."status" in ('accepted', 'rejected')),
	CONSTRAINT "monitoring_config_snapshots_outcome" CHECK (("monitoring_config_snapshots"."status" = 'accepted' and "monitoring_config_snapshots"."accepted_at" is not null and "monitoring_config_snapshots"."rejection_reason" is null)
        or ("monitoring_config_snapshots"."status" = 'rejected' and "monitoring_config_snapshots"."accepted_at" is null and "monitoring_config_snapshots"."rejection_reason" is not null)),
	CONSTRAINT "monitoring_config_snapshots_accepted_order" CHECK ("monitoring_config_snapshots"."accepted_at" is null or "monitoring_config_snapshots"."accepted_at" >= "monitoring_config_snapshots"."seen_at")
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"incident_id" uuid,
	"monitor_id" text NOT NULL,
	"event_type" text NOT NULL,
	"recipient" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"claim_token" uuid,
	"claimed_at" timestamp with time zone,
	"provider_message_id" text,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "notification_outbox_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "notification_outbox_status" CHECK ("notification_outbox"."status" in ('pending', 'sending', 'sent', 'failed', 'dead')),
	CONSTRAINT "notification_outbox_attempts_nonnegative" CHECK ("notification_outbox"."attempt_count" >= 0),
	CONSTRAINT "notification_outbox_claim_pair" CHECK (("notification_outbox"."claim_token" is null) = ("notification_outbox"."claimed_at" is null)),
	CONSTRAINT "notification_outbox_sending_claim" CHECK ("notification_outbox"."status" <> 'sending' or ("notification_outbox"."claim_token" is not null and "notification_outbox"."claimed_at" is not null)),
	CONSTRAINT "notification_outbox_sent_timestamp" CHECK ("notification_outbox"."status" <> 'sent' or "notification_outbox"."sent_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "onboarding_progress" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"current_step" text NOT NULL,
	"draft_monitor" jsonb,
	"email_warning_acknowledged" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "check_results" ADD CONSTRAINT "check_results_monitor_id_monitor_registry_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD CONSTRAINT "cli_sessions_installation_id_cli_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."cli_installations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_rollups" ADD CONSTRAINT "daily_rollups_monitor_id_monitor_registry_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_sessions" ADD CONSTRAINT "human_sessions_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_monitor_id_monitor_registry_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_state" ADD CONSTRAINT "monitor_state_monitor_id_monitor_registry_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_monitor_id_monitor_registry_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_idempotency_principal_key" ON "api_idempotency" USING btree ("principal_key","idempotency_key");--> statement-breakpoint
CREATE INDEX "api_idempotency_expiry" ON "api_idempotency" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "api_rate_limit_buckets_expiry" ON "api_rate_limit_buckets" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "check_results_monitor_schedule" ON "check_results" USING btree ("monitor_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "check_results_monitor_time" ON "check_results" USING btree ("monitor_id","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "check_results_retention" ON "check_results" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "config_operations_target_hash" ON "config_operations" USING btree ("target_config_hash","state");--> statement-breakpoint
CREATE UNIQUE INDEX "cron_runs_job_schedule" ON "cron_runs" USING btree ("job_name","scheduled_minute");--> statement-breakpoint
CREATE UNIQUE INDEX "device_authorizations_active_user_code" ON "device_authorizations" USING btree (lower("user_code")) WHERE "device_authorizations"."state" in ('pending', 'approved');--> statement-breakpoint
CREATE INDEX "incidents_monitor_opened" ON "incidents" USING btree ("monitor_id","opened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_one_active_per_monitor" ON "incidents" USING btree ("monitor_id") WHERE "incidents"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "notification_outbox_due" ON "notification_outbox" USING btree ("next_attempt_at") WHERE "notification_outbox"."status" in ('pending', 'failed');--> statement-breakpoint
CREATE INDEX "notification_outbox_stale_claim" ON "notification_outbox" USING btree ("claimed_at") WHERE "notification_outbox"."status" = 'sending';