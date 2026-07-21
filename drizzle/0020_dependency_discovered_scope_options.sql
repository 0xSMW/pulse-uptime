CREATE TABLE "dependency_discovered_scope_options" (
	"catalog_id" text NOT NULL,
	"scope_id" text NOT NULL,
	"label" text NOT NULL,
	"scope_kind" text NOT NULL,
	"parent_external_id" text,
	"available" boolean NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"metadata" jsonb,
	CONSTRAINT "dependency_discovered_scope_options_catalog_id_scope_id_pk" PRIMARY KEY("catalog_id","scope_id"),
	CONSTRAINT "dependency_discovered_scope_options_scope_kind" CHECK ("dependency_discovered_scope_options"."scope_kind" in ('discovered_child', 'discovered_location'))
);
--> statement-breakpoint
ALTER TABLE "dependency_discovered_scope_options" ADD CONSTRAINT "dependency_discovered_scope_options_catalog_id_dependency_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."dependency_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dependency_discovered_scope_options_catalog_available_label" ON "dependency_discovered_scope_options" USING btree ("catalog_id","available","label");
