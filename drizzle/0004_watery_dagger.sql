ALTER TABLE "admin_users" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "avatar_image_id" uuid;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "timezone" text;