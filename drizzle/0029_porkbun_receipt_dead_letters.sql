ALTER TABLE "porkbun_webhook_receipts" ADD COLUMN "dead_lettered_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX "porkbun_webhook_receipts_pending";--> statement-breakpoint
CREATE INDEX "porkbun_webhook_receipts_pending" ON "porkbun_webhook_receipts" USING btree ("received_at") WHERE "porkbun_webhook_receipts"."processed_at" is null and "porkbun_webhook_receipts"."dead_lettered_at" is null;
