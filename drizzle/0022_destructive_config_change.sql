ALTER TABLE "config_change_approvals" DROP CONSTRAINT "config_change_approvals_action";
--> statement-breakpoint
UPDATE "config_change_approvals" SET "action" = 'destructive_config_change' WHERE "action" = 'bulk_archive';
--> statement-breakpoint
ALTER TABLE "config_change_approvals" ADD CONSTRAINT "config_change_approvals_action" CHECK ("config_change_approvals"."action" = 'destructive_config_change');
