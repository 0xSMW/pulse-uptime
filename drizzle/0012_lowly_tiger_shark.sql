CREATE TABLE "dependencies" (
	"id" text PRIMARY KEY NOT NULL,
	"catalog_id" text NOT NULL,
	"scope_id" text,
	"notifications_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dependency_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"display_name" text NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"selector" jsonb NOT NULL,
	"scope_options" jsonb,
	"source_scope_note" text,
	"catalog_version" text NOT NULL,
	"enabled" boolean NOT NULL,
	"validated_at" timestamp with time zone,
	"validation_error" text,
	CONSTRAINT "dependency_catalog_category" CHECK ("dependency_catalog"."category" in ('ai', 'hosting', 'auth', 'data', 'payments', 'developer'))
);
--> statement-breakpoint
CREATE TABLE "dependency_incident_matches" (
	"dependency_id" text NOT NULL,
	"incident_id" text NOT NULL,
	"match_kind" text NOT NULL,
	"matched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dependency_incident_matches_dependency_id_incident_id_pk" PRIMARY KEY("dependency_id","incident_id"),
	CONSTRAINT "dependency_incident_matches_kind" CHECK ("dependency_incident_matches"."match_kind" in ('component_match', 'inferred'))
);
--> statement-breakpoint
CREATE TABLE "dependency_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_name" text NOT NULL,
	"adapter" text NOT NULL,
	"current_url" text NOT NULL,
	"incidents_url" text,
	"status_page_url" text NOT NULL,
	"allowed_hosts" text[] NOT NULL,
	"config" jsonb NOT NULL,
	"catalog_version" text NOT NULL,
	"enabled" boolean NOT NULL,
	"etag" text,
	"last_modified" text,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"provider_updated_at" timestamp with time zone,
	"next_poll_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"catalog_validated_at" timestamp with time zone,
	"catalog_validation_error" text,
	CONSTRAINT "dependency_sources_adapter" CHECK ("dependency_sources"."adapter" in ('statuspage_v2', 'incidentio_compat', 'google_cloud_status', 'statusio_public', 'sorry_v1')),
	CONSTRAINT "dependency_sources_failures_nonnegative" CHECK ("dependency_sources"."consecutive_failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE "dependency_state" (
	"dependency_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"checking" boolean DEFAULT false NOT NULL,
	"state_started_at" timestamp with time zone NOT NULL,
	"provider_updated_at" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	"last_successful_poll_at" timestamp with time zone,
	CONSTRAINT "dependency_state_state" CHECK ("dependency_state"."state" in ('OPERATIONAL', 'DEGRADED', 'OUTAGE', 'MAINTENANCE', 'UNKNOWN'))
);
--> statement-breakpoint
CREATE TABLE "dependency_state_intervals" (
	"id" text PRIMARY KEY NOT NULL,
	"dependency_id" text NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"source_observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dependency_state_intervals_state" CHECK ("dependency_state_intervals"."state" in ('OPERATIONAL', 'DEGRADED', 'OUTAGE', 'MAINTENANCE', 'UNKNOWN')),
	CONSTRAINT "dependency_state_intervals_order" CHECK ("dependency_state_intervals"."ended_at" is null or "dependency_state_intervals"."ended_at" >= "dependency_state_intervals"."started_at")
);
--> statement-breakpoint
CREATE TABLE "provider_incident_components" (
	"incident_id" text NOT NULL,
	"external_component_id" text NOT NULL,
	"association_kind" text NOT NULL,
	CONSTRAINT "provider_incident_components_incident_id_external_component_id_pk" PRIMARY KEY("incident_id","external_component_id"),
	CONSTRAINT "provider_incident_components_association_kind" CHECK ("provider_incident_components"."association_kind" in ('explicit', 'inferred'))
);
--> statement-breakpoint
CREATE TABLE "provider_incident_updates" (
	"incident_id" text NOT NULL,
	"external_update_id" text NOT NULL,
	"state" text NOT NULL,
	"body_text" text NOT NULL,
	"provider_created_at" timestamp with time zone NOT NULL,
	"provider_updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "provider_incident_updates_incident_id_external_update_id_pk" PRIMARY KEY("incident_id","external_update_id"),
	CONSTRAINT "provider_incident_updates_state" CHECK ("provider_incident_updates"."state" in ('investigating', 'identified', 'monitoring', 'resolved', 'scheduled', 'in_progress', 'completed', 'recovering', 'false_alarm'))
);
--> statement-breakpoint
CREATE TABLE "provider_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"state" text NOT NULL,
	"impact" text,
	"started_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"provider_updated_at" timestamp with time zone NOT NULL,
	"canonical_url" text,
	CONSTRAINT "provider_incidents_state" CHECK ("provider_incidents"."state" in ('investigating', 'identified', 'monitoring', 'resolved', 'scheduled', 'in_progress', 'completed', 'recovering', 'false_alarm')),
	CONSTRAINT "provider_incidents_resolution_order" CHECK ("provider_incidents"."resolved_at" is null or "provider_incidents"."resolved_at" >= "provider_incidents"."started_at")
);
--> statement-breakpoint
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_catalog_id_dependency_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."dependency_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_catalog" ADD CONSTRAINT "dependency_catalog_source_id_dependency_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."dependency_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_incident_matches" ADD CONSTRAINT "dependency_incident_matches_dependency_id_dependencies_id_fk" FOREIGN KEY ("dependency_id") REFERENCES "public"."dependencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_incident_matches" ADD CONSTRAINT "dependency_incident_matches_incident_id_provider_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."provider_incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_state" ADD CONSTRAINT "dependency_state_dependency_id_dependencies_id_fk" FOREIGN KEY ("dependency_id") REFERENCES "public"."dependencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_state_intervals" ADD CONSTRAINT "dependency_state_intervals_dependency_id_dependencies_id_fk" FOREIGN KEY ("dependency_id") REFERENCES "public"."dependencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_incident_components" ADD CONSTRAINT "provider_incident_components_incident_id_provider_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."provider_incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_incident_updates" ADD CONSTRAINT "provider_incident_updates_incident_id_provider_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."provider_incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_incidents" ADD CONSTRAINT "provider_incidents_source_id_dependency_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."dependency_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dependencies_active_catalog_scope" ON "dependencies" USING btree ("catalog_id",coalesce("scope_id", '')) WHERE "dependencies"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "dependency_sources_next_poll" ON "dependency_sources" USING btree ("next_poll_at") WHERE "dependency_sources"."enabled" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_state_intervals_one_open" ON "dependency_state_intervals" USING btree ("dependency_id") WHERE "dependency_state_intervals"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "dependency_state_intervals_dependency_time" ON "dependency_state_intervals" USING btree ("dependency_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "provider_incidents_source_external" ON "provider_incidents" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "provider_incidents_source_started" ON "provider_incidents" USING btree ("source_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "provider_incidents_unresolved" ON "provider_incidents" USING btree ("resolved_at") WHERE "provider_incidents"."resolved_at" is null;