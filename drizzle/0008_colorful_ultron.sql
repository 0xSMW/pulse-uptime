CREATE TABLE "status_report_affected" (
	"report_id" uuid NOT NULL,
	"monitor_id" text NOT NULL,
	"monitor_name" text NOT NULL,
	"group_name" text,
	"impact" text NOT NULL,
	CONSTRAINT "status_report_affected_report_id_monitor_id_pk" PRIMARY KEY("report_id","monitor_id"),
	CONSTRAINT "status_report_affected_impact" CHECK ("status_report_affected"."impact" in ('down', 'degraded', 'maintenance'))
);
--> statement-breakpoint
CREATE TABLE "status_report_updates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"report_id" uuid NOT NULL,
	"status" text NOT NULL,
	"markdown" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "status_report_updates_status" CHECK ("status_report_updates"."status" in ('investigating', 'identified', 'monitoring', 'resolved', 'scheduled', 'in_progress', 'completed')),
	CONSTRAINT "status_report_updates_markdown_length" CHECK (char_length("status_report_updates"."markdown") between 1 and 10240)
);
--> statement-breakpoint
CREATE TABLE "status_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"origin_incident_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "status_reports_type" CHECK ("status_reports"."type" in ('incident', 'maintenance')),
	CONSTRAINT "status_reports_title_length" CHECK (char_length("status_reports"."title") between 1 and 160)
);
--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD COLUMN "scope_profile" text;--> statement-breakpoint
-- Every existing CLI session was minted through the device flow, which only
-- supports the administrator profile; backfill so auth-time profile resolution
-- grants newly introduced scopes (reports:*) to pre-existing sessions.
UPDATE "cli_sessions" SET "scope_profile" = 'administrator';--> statement-breakpoint
ALTER TABLE "status_report_affected" ADD CONSTRAINT "status_report_affected_report_id_status_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."status_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_report_affected" ADD CONSTRAINT "status_report_affected_monitor_id_monitor_registry_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_report_updates" ADD CONSTRAINT "status_report_updates_report_id_status_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."status_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_reports" ADD CONSTRAINT "status_reports_origin_incident_id_incidents_id_fk" FOREIGN KEY ("origin_incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "status_report_affected_monitor" ON "status_report_affected" USING btree ("monitor_id");--> statement-breakpoint
CREATE INDEX "status_report_updates_latest" ON "status_report_updates" USING btree ("report_id","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "status_reports_origin" ON "status_reports" USING btree ("origin_incident_id") WHERE "status_reports"."origin_incident_id" is not null;--> statement-breakpoint
CREATE INDEX "status_reports_ongoing" ON "status_reports" USING btree ("starts_at" DESC NULLS LAST) WHERE "status_reports"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "status_reports_cursor" ON "status_reports" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);