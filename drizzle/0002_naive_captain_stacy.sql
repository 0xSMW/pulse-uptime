CREATE TABLE "check_batches" (
	"scheduled_minute" timestamp with time zone PRIMARY KEY NOT NULL,
	"encoding_version" integer NOT NULL,
	"config_version" integer NOT NULL,
	"monitor_ids" text[] NOT NULL,
	"expected_bitmap" "bytea" NOT NULL,
	"completed_bitmap" "bytea" NOT NULL,
	"failure_bitmap" "bytea" NOT NULL,
	"latency_values" "bytea" NOT NULL,
	"scheduler_started_at" timestamp with time zone NOT NULL,
	"scheduler_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "check_batches_encoding_version" CHECK ("check_batches"."encoding_version" > 0),
	CONSTRAINT "check_batches_config_version" CHECK ("check_batches"."config_version" >= 0),
	CONSTRAINT "check_batches_completion_order" CHECK ("check_batches"."scheduler_completed_at" is null or "check_batches"."scheduler_completed_at" >= "check_batches"."scheduler_started_at")
);
--> statement-breakpoint
CREATE TABLE "database_usage_snapshots" (
	"captured_at" timestamp with time zone PRIMARY KEY NOT NULL,
	"storage_bytes" bigint NOT NULL,
	"index_bytes" bigint NOT NULL,
	"category_bytes" jsonb NOT NULL,
	"history_bytes" bigint,
	"monthly_transfer_bytes" bigint,
	"projected_30_day_bytes" bigint NOT NULL,
	"governor_mode" text NOT NULL,
	"last_compaction_at" timestamp with time zone,
	"scheduler_coverage" numeric(7, 4),
	"provider_metrics_captured_at" timestamp with time zone,
	CONSTRAINT "database_usage_snapshots_bytes" CHECK ("database_usage_snapshots"."storage_bytes" >= 0 and "database_usage_snapshots"."index_bytes" >= 0 and "database_usage_snapshots"."projected_30_day_bytes" >= 0 and ("database_usage_snapshots"."history_bytes" is null or "database_usage_snapshots"."history_bytes" >= 0) and ("database_usage_snapshots"."monthly_transfer_bytes" is null or "database_usage_snapshots"."monthly_transfer_bytes" >= 0)),
	CONSTRAINT "database_usage_snapshots_governor" CHECK ("database_usage_snapshots"."governor_mode" in ('full', 'compact_early', 'shortened', 'incident_only', 'essential')),
	CONSTRAINT "database_usage_snapshots_coverage" CHECK ("database_usage_snapshots"."scheduler_coverage" is null or "database_usage_snapshots"."scheduler_coverage" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "exception_payloads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "exception_payloads_expiry_order" CHECK ("exception_payloads"."expires_at" > "exception_payloads"."created_at")
);
--> statement-breakpoint
CREATE TABLE "metric_rollups" (
	"monitor_id" text NOT NULL,
	"resolution" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"expected_checks" integer NOT NULL,
	"completed_checks" integer NOT NULL,
	"successful_checks" integer NOT NULL,
	"failed_checks" integer NOT NULL,
	"unknown_checks" integer NOT NULL,
	"downtime_seconds" integer NOT NULL,
	"unknown_seconds" integer NOT NULL,
	"latency_count" integer NOT NULL,
	"latency_sum_ms" bigint NOT NULL,
	"latency_min_ms" integer,
	"latency_max_ms" integer,
	"latency_histogram" integer[] NOT NULL,
	"histogram_version" integer NOT NULL,
	"has_incident" boolean NOT NULL,
	"compacted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "metric_rollups_monitor_id_resolution_bucket_start_pk" PRIMARY KEY("monitor_id","resolution","bucket_start"),
	CONSTRAINT "metric_rollups_resolution" CHECK ("metric_rollups"."resolution" in ('15m', 'hour', 'day')),
	CONSTRAINT "metric_rollups_counts" CHECK ("metric_rollups"."expected_checks" >= 0 and "metric_rollups"."completed_checks" >= 0 and "metric_rollups"."successful_checks" >= 0 and "metric_rollups"."failed_checks" >= 0 and "metric_rollups"."unknown_checks" >= 0 and "metric_rollups"."completed_checks" <= "metric_rollups"."expected_checks" and "metric_rollups"."successful_checks" + "metric_rollups"."failed_checks" = "metric_rollups"."completed_checks" and "metric_rollups"."unknown_checks" = "metric_rollups"."expected_checks" - "metric_rollups"."completed_checks"),
	CONSTRAINT "metric_rollups_seconds" CHECK ("metric_rollups"."downtime_seconds" >= 0 and "metric_rollups"."unknown_seconds" >= 0),
	CONSTRAINT "metric_rollups_latency" CHECK ("metric_rollups"."latency_count" >= 0 and "metric_rollups"."latency_sum_ms" >= 0 and ("metric_rollups"."latency_min_ms" is null or "metric_rollups"."latency_min_ms" >= 0) and ("metric_rollups"."latency_max_ms" is null or "metric_rollups"."latency_max_ms" >= 0) and ("metric_rollups"."latency_min_ms" is null or "metric_rollups"."latency_max_ms" is null or "metric_rollups"."latency_min_ms" <= "metric_rollups"."latency_max_ms")),
	CONSTRAINT "metric_rollups_histogram" CHECK ("metric_rollups"."histogram_version" > 0 and cardinality("metric_rollups"."latency_histogram") = 8)
);
--> statement-breakpoint
CREATE TABLE "monitor_exceptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"monitor_id" text,
	"event_type" text NOT NULL,
	"error_code" text,
	"identity_hash" "bytea" NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"occurrence_count" integer NOT NULL,
	"worst_latency_ms" integer,
	"incident_id" uuid,
	"payload_id" uuid,
	CONSTRAINT "monitor_exceptions_event_type" CHECK ("monitor_exceptions"."event_type" in ('failure', 'recovery', 'pause', 'resume', 'scheduler_gap', 'configuration')),
	CONSTRAINT "monitor_exceptions_occurrences" CHECK ("monitor_exceptions"."occurrence_count" > 0),
	CONSTRAINT "monitor_exceptions_seen_order" CHECK ("monitor_exceptions"."last_seen_at" >= "monitor_exceptions"."first_seen_at"),
	CONSTRAINT "monitor_exceptions_latency" CHECK ("monitor_exceptions"."worst_latency_ms" is null or "monitor_exceptions"."worst_latency_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "metric_rollups" ADD CONSTRAINT "metric_rollups_monitor_id_monitor_registry_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_exceptions" ADD CONSTRAINT "monitor_exceptions_monitor_id_monitor_registry_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_exceptions" ADD CONSTRAINT "monitor_exceptions_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_exceptions" ADD CONSTRAINT "monitor_exceptions_payload_id_exception_payloads_id_fk" FOREIGN KEY ("payload_id") REFERENCES "public"."exception_payloads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exception_payloads_retention" ON "exception_payloads" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "metric_rollups_retention" ON "metric_rollups" USING btree ("resolution","bucket_start","monitor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "monitor_exceptions_identity" ON "monitor_exceptions" USING btree ("monitor_id","event_type","identity_hash",coalesce("incident_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "monitor_exceptions_retention" ON "monitor_exceptions" USING btree ("last_seen_at","id");--> statement-breakpoint
CREATE INDEX "monitor_exceptions_incident" ON "monitor_exceptions" USING btree ("incident_id");
--> statement-breakpoint
CREATE FUNCTION pulse_assert_equal(actual bigint, expected bigint) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
	IF actual <> expected THEN
		RAISE EXCEPTION 'Atomic minute state version mismatch: applied %, expected %', actual, expected;
	END IF;
	RETURN true;
END;
$$;
