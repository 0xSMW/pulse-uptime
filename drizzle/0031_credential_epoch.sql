ALTER TABLE "admin_users" ADD COLUMN "credential_epoch" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "credential_owner_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "credential_epoch" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "cli_installations" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "cli_installations" ADD COLUMN "credential_epoch" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "api_tokens" AS token
SET "credential_owner_user_id" = users."id"
FROM "admin_users" AS users
WHERE token."principal_type" = 'human'
  AND token."principal_id" = users."id"::text;
--> statement-breakpoint
UPDATE "api_tokens" AS token
SET "credential_owner_user_id" = users."id"
FROM "cli_sessions" AS sessions
JOIN "admin_users" AS users ON users."email" = sessions."user_email"
WHERE token."principal_type" = 'cli_session'
  AND token."principal_id" = sessions."id"::text;
--> statement-breakpoint
WITH RECURSIVE token_owners AS (
  SELECT token."id", token."credential_owner_user_id"
  FROM "api_tokens" AS token
  WHERE token."credential_owner_user_id" IS NOT NULL
  UNION
  SELECT child."id", parent."credential_owner_user_id"
  FROM "api_tokens" AS child
  JOIN token_owners AS parent ON child."principal_type" = 'api_token'
    AND child."principal_id" = parent."id"::text
  WHERE child."credential_owner_user_id" IS NULL
)
UPDATE "api_tokens" AS token
SET "credential_owner_user_id" = owners."credential_owner_user_id"
FROM token_owners AS owners
WHERE token."id" = owners."id"
  AND token."credential_owner_user_id" IS NULL;
--> statement-breakpoint
UPDATE "api_tokens" AS token
SET "credential_epoch" = users."credential_epoch"
FROM "admin_users" AS users
WHERE token."credential_owner_user_id" = users."id";
--> statement-breakpoint
UPDATE "cli_installations" AS installation
SET "user_id" = users."id",
    "credential_epoch" = users."credential_epoch"
FROM "admin_users" AS users
WHERE installation."user_email" = users."email";
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_credential_owner_user_id_admin_users_id_fk" FOREIGN KEY ("credential_owner_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cli_installations" ADD CONSTRAINT "cli_installations_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION "pulse_lock_machine_credentials"() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pulse:machine-credentials'));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "admin_users_lock_machine_credentials"
BEFORE UPDATE OF "password_digest" ON "admin_users"
FOR EACH STATEMENT EXECUTE FUNCTION "pulse_lock_machine_credentials"();
--> statement-breakpoint
CREATE FUNCTION "pulse_advance_credential_epoch"() RETURNS trigger AS $$
BEGIN
  IF NEW."password_digest" IS DISTINCT FROM OLD."password_digest" THEN
    NEW."credential_epoch" := OLD."credential_epoch" + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "admin_users_advance_credential_epoch"
BEFORE UPDATE OF "password_digest" ON "admin_users"
FOR EACH ROW EXECUTE FUNCTION "pulse_advance_credential_epoch"();
--> statement-breakpoint
CREATE FUNCTION "pulse_revoke_rotated_credentials"() RETURNS trigger AS $$
BEGIN
  IF NEW."password_digest" IS DISTINCT FROM OLD."password_digest" THEN
    UPDATE "human_sessions"
    SET "revoked_at" = COALESCE("revoked_at", NEW."password_changed_at")
    WHERE "user_id" = NEW."id" AND "revoked_at" IS NULL;

    WITH RECURSIVE token_tree(id) AS (
      SELECT token."id"
      FROM "api_tokens" AS token
      WHERE token."credential_owner_user_id" = NEW."id"
         OR token."created_by_principal" = 'human:' || NEW."id"::text
         OR token."created_by_principal" IN (
           SELECT 'cli_session:' || session."id"::text
           FROM "cli_sessions" AS session
           INNER JOIN "cli_installations" AS installation
             ON installation."id" = session."installation_id"
           WHERE installation."user_id" = NEW."id"
              OR installation."user_email" = NEW."email"
         )
      UNION
      SELECT child."id"
      FROM "api_tokens" AS child
      INNER JOIN token_tree AS parent
        ON child."created_by_principal" = 'api_token:' || parent.id::text
    )
    UPDATE "api_tokens"
    SET "revoked_at" = COALESCE("revoked_at", NEW."password_changed_at")
    WHERE "id" IN (SELECT id FROM token_tree)
      AND "revoked_at" IS NULL;

    UPDATE "cli_sessions" AS session
    SET "revoked_at" = COALESCE(session."revoked_at", NEW."password_changed_at")
    FROM "cli_installations" AS installation
    WHERE session."installation_id" = installation."id"
      AND (installation."user_id" = NEW."id" OR installation."user_email" = NEW."email")
      AND session."revoked_at" IS NULL;

    UPDATE "cli_installations"
    SET "revoked_at" = COALESCE("revoked_at", NEW."password_changed_at")
    WHERE ("user_id" = NEW."id" OR "user_email" = NEW."email")
      AND "revoked_at" IS NULL;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "admin_users_revoke_rotated_credentials"
AFTER UPDATE OF "password_digest" ON "admin_users"
FOR EACH ROW EXECUTE FUNCTION "pulse_revoke_rotated_credentials"();
