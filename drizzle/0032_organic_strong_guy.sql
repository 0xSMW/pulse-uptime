CREATE TABLE "incident_exclusion_checks" (
	"exclusion_id" uuid NOT NULL,
	"scheduled_minute" timestamp with time zone NOT NULL,
	"monitor_id" text NOT NULL,
	"failed" boolean NOT NULL,
	"downtime_seconds" integer NOT NULL,
	CONSTRAINT "incident_exclusion_checks_exclusion_id_scheduled_minute_pk" PRIMARY KEY("exclusion_id","scheduled_minute"),
	CONSTRAINT "incident_exclusion_checks_downtime" CHECK ("incident_exclusion_checks"."downtime_seconds" in (0, 60))
);
--> statement-breakpoint
CREATE TABLE "incident_exclusions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"monitor_id" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"created_by_principal" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"reverted_at" timestamp with time zone,
	"reverted_by_principal" text,
	CONSTRAINT "incident_exclusions_range" CHECK ("incident_exclusions"."start_at" < "incident_exclusions"."end_at" and isfinite("incident_exclusions"."start_at") and isfinite("incident_exclusions"."end_at") and date_trunc('minute', "incident_exclusions"."start_at") = "incident_exclusions"."start_at" and date_trunc('minute', "incident_exclusions"."end_at") = "incident_exclusions"."end_at"),
	CONSTRAINT "incident_exclusions_reason" CHECK (length(btrim("incident_exclusions"."reason")) between 1 and 1000),
	CONSTRAINT "incident_exclusions_revert" CHECK (("incident_exclusions"."reverted_at" is null) = ("incident_exclusions"."reverted_by_principal" is null))
);
--> statement-breakpoint
ALTER TABLE "incident_exclusion_checks" ADD CONSTRAINT "incident_exclusion_checks_exclusion_id_incident_exclusions_id_fk" FOREIGN KEY ("exclusion_id") REFERENCES "public"."incident_exclusions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_exclusion_checks" ADD CONSTRAINT "incident_exclusion_checks_monitor_id_monitor_registry_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_exclusions" ADD CONSTRAINT "incident_exclusions_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_exclusions" ADD CONSTRAINT "incident_exclusions_monitor_id_monitor_registry_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_exclusion_checks_monitor_minute" ON "incident_exclusion_checks" USING btree ("monitor_id","scheduled_minute");--> statement-breakpoint
CREATE UNIQUE INDEX "incident_exclusions_active_incident" ON "incident_exclusions" USING btree ("incident_id") WHERE "incident_exclusions"."reverted_at" is null;--> statement-breakpoint
CREATE INDEX "incident_exclusions_monitor_range" ON "incident_exclusions" USING btree ("monitor_id","start_at","end_at");