CREATE TABLE "user_invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_digest" "bytea" NOT NULL,
	"role" text NOT NULL,
	"created_by_principal" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "user_invites_token_digest_unique" UNIQUE("token_digest"),
	CONSTRAINT "user_invites_role" CHECK ("user_invites"."role" in ('admin', 'viewer')),
	CONSTRAINT "user_invites_expiry_order" CHECK ("user_invites"."expires_at" > "user_invites"."created_at")
);
--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "role" text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_role" CHECK ("admin_users"."role" in ('admin', 'viewer'));