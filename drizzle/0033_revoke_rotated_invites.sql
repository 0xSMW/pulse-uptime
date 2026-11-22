-- A password update from an older application release still reaches the
-- database trigger installed by 0031. Invalidate pending join links in the
-- same transaction as its credential revocation.
CREATE FUNCTION "pulse_revoke_rotated_invites"() RETURNS trigger AS $$
BEGIN
  IF NEW."password_digest" IS DISTINCT FROM OLD."password_digest" THEN
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
    UPDATE "user_invites" AS invite
    SET "revoked_at" = NEW."password_changed_at"
    WHERE invite."accepted_at" IS NULL
      AND invite."revoked_at" IS NULL
      AND (
        invite."created_by_principal" = 'human:' || NEW."id"::text
        OR invite."created_by_principal" IN (
          SELECT 'cli_session:' || session."id"::text
          FROM "cli_sessions" AS session
          INNER JOIN "cli_installations" AS installation
            ON installation."id" = session."installation_id"
          WHERE installation."user_id" = NEW."id"
             OR installation."user_email" = NEW."email"
        )
        OR invite."created_by_principal" IN (
          SELECT 'api_token:' || token_tree.id::text FROM token_tree
        )
      );
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "admin_users_revoke_rotated_invites"
AFTER UPDATE OF "password_digest" ON "admin_users"
FOR EACH ROW EXECUTE FUNCTION "pulse_revoke_rotated_invites"();
--> statement-breakpoint
-- An older release can rename an email without calling the new account
-- service. Match both addresses before its CLI rows are rewritten.
CREATE FUNCTION "pulse_revoke_renamed_invites"() RETURNS trigger AS $$
BEGIN
  IF NEW."email" IS DISTINCT FROM OLD."email" THEN
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
              OR installation."user_email" IN (OLD."email", NEW."email")
              OR session."user_email" IN (OLD."email", NEW."email")
         )
      UNION
      SELECT child."id"
      FROM "api_tokens" AS child
      INNER JOIN token_tree AS parent
        ON child."created_by_principal" = 'api_token:' || parent.id::text
    )
    UPDATE "user_invites" AS invite
    SET "revoked_at" = CURRENT_TIMESTAMP
    WHERE invite."accepted_at" IS NULL
      AND invite."revoked_at" IS NULL
      AND (
        invite."created_by_principal" = 'human:' || NEW."id"::text
        OR invite."created_by_principal" IN (
          SELECT 'cli_session:' || session."id"::text
          FROM "cli_sessions" AS session
          INNER JOIN "cli_installations" AS installation
            ON installation."id" = session."installation_id"
          WHERE installation."user_id" = NEW."id"
             OR installation."user_email" IN (OLD."email", NEW."email")
             OR session."user_email" IN (OLD."email", NEW."email")
        )
        OR invite."created_by_principal" IN (
          SELECT 'api_token:' || token_tree.id::text FROM token_tree
        )
      );
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "admin_users_revoke_renamed_invites"
AFTER UPDATE OF "email" ON "admin_users"
FOR EACH ROW EXECUTE FUNCTION "pulse_revoke_renamed_invites"();
