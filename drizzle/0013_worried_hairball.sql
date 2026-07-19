ALTER TABLE "monitor_state" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
-- The exact first successful check instant anchors activation, matching the
-- runtime state machine which stamps activated_at at that instant. Raw check
-- history holds it while retention keeps the row. Filtering by bucket_start,
-- the exact instant and the successful bucket end select the same buckets since
-- both fall inside the excluded straddling bucket, so uptime and coverage are
-- unchanged, while an incident opened later in that bucket now passes the
-- opened_at at or after activated_at gate instead of vanishing as setup noise.
-- Older monitors past raw retention fall back to the per-resolution bucket end.
UPDATE "monitor_state" SET "activated_at" = COALESCE(
  (SELECT MIN("c"."checked_at") FROM "check_results" "c" WHERE "c"."monitor_id" = "monitor_state"."monitor_id" AND "c"."successful"),
  LEAST(
    (SELECT MIN("r"."bucket_start" + interval '15 minutes') FROM "metric_rollups" "r" WHERE "r"."monitor_id" = "monitor_state"."monitor_id" AND "r"."resolution" = '15m' AND "r"."successful_checks" > 0),
    (SELECT MIN("r"."bucket_start" + interval '1 hour') FROM "metric_rollups" "r" WHERE "r"."monitor_id" = "monitor_state"."monitor_id" AND "r"."resolution" = 'hour' AND "r"."successful_checks" > 0),
    (SELECT MIN("r"."bucket_start" + interval '1 day') FROM "metric_rollups" "r" WHERE "r"."monitor_id" = "monitor_state"."monitor_id" AND "r"."resolution" = 'day' AND "r"."successful_checks" > 0)
  ),
  "first_success_at",
  "last_success_at"
) WHERE "activated_at" IS NULL AND ("first_success_at" IS NOT NULL OR "last_success_at" IS NOT NULL);--> statement-breakpoint
UPDATE "monitor_state" SET "activated_at" = COALESCE(
  "first_failure_at",
  (SELECT "i"."opened_at" FROM "incidents" "i" WHERE "i"."id" = "monitor_state"."active_incident_id"),
  "updated_at"
) WHERE "activated_at" IS NULL AND "active_incident_id" IS NOT NULL;--> statement-breakpoint
-- A monitor with an active incident holds activated_at at or before that
-- incident opened_at, so the openedAt at or after activatedAt read gate always
-- surfaces the ongoing incident. LEAST clamps downward only. A healthy monitor
-- whose activated_at already predates the incident keeps its true first success,
-- while a monitor recovering from a never-succeeded outage gets pulled back from
-- its recovery success to the incident open. LEAST ignores a null first_failure_at.
UPDATE "monitor_state" SET "activated_at" = LEAST(
  "activated_at",
  "first_failure_at",
  (SELECT "i"."opened_at" FROM "incidents" "i" WHERE "i"."id" = "monitor_state"."active_incident_id")
) WHERE "active_incident_id" IS NOT NULL AND "activated_at" IS NOT NULL;
