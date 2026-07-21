ALTER TABLE "config_change_approvals" DROP CONSTRAINT "config_change_approvals_action";
--> statement-breakpoint
ALTER TABLE "config_change_approvals" ADD CONSTRAINT "config_change_approvals_action" CHECK ("config_change_approvals"."action" in ('destructive_config_change', 'bulk_archive'));
