ALTER TABLE "monitor_state" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
UPDATE "monitor_state" SET "activated_at" = COALESCE(
  (SELECT MIN("r"."bucket_start") FROM "metric_rollups" "r" WHERE "r"."monitor_id" = "monitor_state"."monitor_id" AND "r"."successful_checks" > 0),
  "first_success_at",
  "last_success_at"
) WHERE "activated_at" IS NULL AND ("first_success_at" IS NOT NULL OR "last_success_at" IS NOT NULL);
