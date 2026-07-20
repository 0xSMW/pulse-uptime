ALTER TABLE "notification_outbox" DROP CONSTRAINT "notification_outbox_subject";--> statement-breakpoint
ALTER TABLE "cron_runs" ADD COLUMN "error_detail" jsonb;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_subject" CHECK (("notification_outbox"."event_type" = 'system.alert' and "notification_outbox"."monitor_id" is null and "notification_outbox"."dependency_id" is null)
      or (("notification_outbox"."monitor_id" is null) <> ("notification_outbox"."dependency_id" is null)));