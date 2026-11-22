ALTER TABLE "api_tokens" ADD COLUMN "issued_by_human_session_id" uuid;--> statement-breakpoint
ALTER TABLE "cli_installations" ADD COLUMN "authorized_by_human_session_id" uuid;--> statement-breakpoint
CREATE INDEX "api_tokens_issuer_session" ON "api_tokens" USING btree ("issued_by_human_session_id") WHERE "api_tokens"."issued_by_human_session_id" is not null;--> statement-breakpoint
CREATE INDEX "cli_installations_authorizer_session" ON "cli_installations" USING btree ("authorized_by_human_session_id") WHERE "cli_installations"."authorized_by_human_session_id" is not null;