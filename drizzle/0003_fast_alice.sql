CREATE TABLE "atomic_minute_commits" (
	"scheduled_minute" timestamp with time zone PRIMARY KEY NOT NULL,
	"state_mutation_count" integer NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "atomic_minute_commits_state_count" CHECK ("atomic_minute_commits"."state_mutation_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "atomic_minute_commits" ADD CONSTRAINT "atomic_minute_commits_scheduled_minute_check_batches_scheduled_minute_fk" FOREIGN KEY ("scheduled_minute") REFERENCES "public"."check_batches"("scheduled_minute") ON DELETE cascade ON UPDATE no action;