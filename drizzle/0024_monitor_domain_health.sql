CREATE TABLE "monitor_domain_health" (
	"monitor_id" text PRIMARY KEY NOT NULL,
	"hostname" text NOT NULL,
	"apex_domain" text,
	"cert_expires_at" timestamp with time zone,
	"cert_issuer" text,
	"domain_expires_at" timestamp with time zone,
	"domain_registrar" text,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monitor_domain_health" ADD CONSTRAINT "monitor_domain_health_monitor_id_monitor_registry_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitor_domain_health_checked" ON "monitor_domain_health" USING btree ("checked_at");