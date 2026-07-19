CREATE TABLE "images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "images_kind" CHECK ("images"."kind" in ('logo-light', 'logo-dark', 'favicon', 'avatar')),
	CONSTRAINT "images_byte_size_positive" CHECK ("images"."byte_size" > 0)
);
--> statement-breakpoint
CREATE TABLE "status_page_config" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"name" text,
	"layout" text DEFAULT 'vertical' NOT NULL,
	"theme" text DEFAULT 'system' NOT NULL,
	"logo_light_image_id" uuid,
	"logo_dark_image_id" uuid,
	"favicon_image_id" uuid,
	"homepage_url" text,
	"contact_url" text,
	"nav_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"google_tag_id" text,
	"custom_css" text,
	"custom_head" text,
	"announcement_enabled" boolean DEFAULT false NOT NULL,
	"announcement_markdown" text,
	"history_days" integer DEFAULT 90 NOT NULL,
	"uptime_decimals" integer DEFAULT 2 NOT NULL,
	"unknown_as_operational" boolean DEFAULT false NOT NULL,
	"min_incident_seconds" integer DEFAULT 0 NOT NULL,
	"timezone" text,
	"updated_at" timestamp with time zone,
	CONSTRAINT "status_page_config_single_row" CHECK ("status_page_config"."id" = 1),
	CONSTRAINT "status_page_config_layout" CHECK ("status_page_config"."layout" in ('vertical', 'horizontal')),
	CONSTRAINT "status_page_config_theme" CHECK ("status_page_config"."theme" in ('system', 'light', 'dark')),
	CONSTRAINT "status_page_config_history_days" CHECK ("status_page_config"."history_days" in (30, 60, 90)),
	CONSTRAINT "status_page_config_uptime_decimals" CHECK ("status_page_config"."uptime_decimals" between 0 and 3),
	CONSTRAINT "status_page_config_min_incident_seconds" CHECK ("status_page_config"."min_incident_seconds" >= 0 and "status_page_config"."min_incident_seconds" <= 604800)
);

--> statement-breakpoint
INSERT INTO "status_page_config" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
