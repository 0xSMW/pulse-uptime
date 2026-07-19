CREATE INDEX "api_tokens_active_creator" ON "api_tokens" USING btree ("created_by_principal") WHERE "api_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "cli_sessions_installation" ON "cli_sessions" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "config_operations_principal_idempotency" ON "config_operations" USING btree ("principal_key","idempotency_key");--> statement-breakpoint
CREATE INDEX "incidents_feed_order" ON "incidents" USING btree ("opened_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "monitoring_config_snapshots_accepted_order" ON "monitoring_config_snapshots" USING btree ("accepted_at" DESC NULLS LAST,"seen_at" DESC NULLS LAST) WHERE "monitoring_config_snapshots"."status" = 'accepted';--> statement-breakpoint
CREATE INDEX "notification_outbox_incident" ON "notification_outbox" USING btree ("incident_id") WHERE "notification_outbox"."incident_id" is not null;