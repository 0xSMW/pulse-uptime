ALTER TABLE "monitor_state" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
UPDATE "monitor_state" SET "activated_at" = COALESCE(
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
) WHERE "activated_at" IS NULL AND "active_incident_id" IS NOT NULL;
