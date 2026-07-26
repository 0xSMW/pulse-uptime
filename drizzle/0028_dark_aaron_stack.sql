CREATE TABLE "porkbun_integration" (
	"id" text PRIMARY KEY NOT NULL,
	"expiry_alerts_enabled" boolean DEFAULT false NOT NULL,
	"covered_domain_count" integer DEFAULT 0 NOT NULL,
	"provider_checked_at" timestamp with time zone,
	"provider_last_success_at" timestamp with time zone,
	"provider_last_error_code" text,
	"webhook_id" integer,
	"webhook_url" text,
	"webhook_secret_encrypted" text,
	"webhook_status" text,
	"webhook_last_received_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "porkbun_integration_singleton" CHECK ("porkbun_integration"."id" = 'default'),
	CONSTRAINT "porkbun_integration_covered_nonnegative" CHECK ("porkbun_integration"."covered_domain_count" >= 0),
	CONSTRAINT "porkbun_integration_webhook_pair" CHECK (("porkbun_integration"."webhook_id" is null) = ("porkbun_integration"."webhook_secret_encrypted" is null))
);
--> statement-breakpoint
CREATE TABLE "porkbun_webhook_receipts" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"apex_domain" text,
	"expire_date" text,
	"provider_created_at" timestamp with time zone NOT NULL,
	"payload_digest" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"processing_started_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	CONSTRAINT "porkbun_webhook_receipts_event_type" CHECK ("porkbun_webhook_receipts"."event_type" in ('domain.renewed', 'domain.expiring', 'webhook.test')),
	CONSTRAINT "porkbun_webhook_receipts_domain" CHECK (("porkbun_webhook_receipts"."event_type" = 'webhook.test' and "porkbun_webhook_receipts"."apex_domain" is null)
      or ("porkbun_webhook_receipts"."event_type" in ('domain.renewed', 'domain.expiring') and "porkbun_webhook_receipts"."apex_domain" is not null)),
	CONSTRAINT "porkbun_webhook_receipts_attempts_nonnegative" CHECK ("porkbun_webhook_receipts"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" DROP CONSTRAINT "notification_outbox_subject";--> statement-breakpoint
ALTER TABLE "domain_health_assets" ADD COLUMN "registration_source" text DEFAULT 'rdap' NOT NULL;--> statement-breakpoint
ALTER TABLE "domain_health_assets" ADD COLUMN "auto_renew" boolean;--> statement-breakpoint
ALTER TABLE "domain_health_assets" ADD COLUMN "registration_status" text;--> statement-breakpoint
CREATE INDEX "porkbun_webhook_receipts_pending" ON "porkbun_webhook_receipts" USING btree ("received_at") WHERE "porkbun_webhook_receipts"."processed_at" is null;--> statement-breakpoint
ALTER TABLE "domain_health_assets" ADD CONSTRAINT "domain_health_assets_registration_source" CHECK ("domain_health_assets"."registration_source" in ('rdap', 'porkbun'));--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_subject" CHECK (("notification_outbox"."event_type" in ('system.alert', 'domain.expiry') and "notification_outbox"."monitor_id" is null and "notification_outbox"."dependency_id" is null)
      or (("notification_outbox"."monitor_id" is null) <> ("notification_outbox"."dependency_id" is null)));