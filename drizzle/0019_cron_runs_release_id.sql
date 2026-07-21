ALTER TABLE "cron_runs" ADD COLUMN "release_id" text;--> statement-breakpoint
ALTER TABLE "cron_runs" ADD CONSTRAINT "cron_runs_release_id" CHECK ("cron_runs"."release_id" is null or length(trim("cron_runs"."release_id")) > 0);--> statement-breakpoint
CREATE INDEX "cron_runs_job_release_completed" ON "cron_runs" USING btree ("job_name","release_id","completed_at" DESC) WHERE "cron_runs"."status" = 'completed' and "cron_runs"."release_id" is not null;
