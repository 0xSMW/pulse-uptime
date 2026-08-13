ALTER TABLE "images" ADD COLUMN "uploaded_by_user_id" uuid;--> statement-breakpoint
DO $$
BEGIN
	LOCK TABLE "admin_users" IN SHARE ROW EXCLUSIVE MODE;

	IF EXISTS (
		SELECT 1
		FROM "admin_users"
		INNER JOIN "images" ON "images"."id" = "admin_users"."avatar_image_id"
		WHERE "images"."kind" <> 'avatar'
	) THEN
		RAISE EXCEPTION 'cannot backfill image ownership: an avatar reference points to a non-avatar image';
	END IF;

	WITH "ranked_avatar_references" AS (
	SELECT
		"admin_users"."id" AS "user_id",
		"admin_users"."avatar_image_id" AS "original_image_id",
		row_number() OVER (
			PARTITION BY "admin_users"."avatar_image_id"
			ORDER BY "admin_users"."id"
		) AS "owner_rank"
	FROM "admin_users"
	WHERE "admin_users"."avatar_image_id" IS NOT NULL
	),
	"avatar_clones" AS (
		SELECT
			"ranked_avatar_references"."user_id",
			"ranked_avatar_references"."original_image_id",
			gen_random_uuid() AS "clone_image_id"
		FROM "ranked_avatar_references"
		WHERE "ranked_avatar_references"."owner_rank" > 1
	),
	"inserted_avatar_clones" AS (
		INSERT INTO "images" (
			"id",
			"kind",
			"mime_type",
			"bytes",
			"byte_size",
			"created_at",
			"uploaded_by_user_id"
		)
		SELECT
			"avatar_clones"."clone_image_id",
			"images"."kind",
			"images"."mime_type",
			"images"."bytes",
			"images"."byte_size",
			"images"."created_at",
			"avatar_clones"."user_id"
		FROM "avatar_clones"
		INNER JOIN "images" ON "images"."id" = "avatar_clones"."original_image_id"
		RETURNING "id"
	)
	UPDATE "admin_users"
	SET "avatar_image_id" = "avatar_clones"."clone_image_id"
	FROM "avatar_clones"
	INNER JOIN "inserted_avatar_clones"
		ON "inserted_avatar_clones"."id" = "avatar_clones"."clone_image_id"
	WHERE "admin_users"."id" = "avatar_clones"."user_id"
		AND "admin_users"."avatar_image_id" = "avatar_clones"."original_image_id";

	UPDATE "images"
	SET "uploaded_by_user_id" = "admin_users"."id"
	FROM "admin_users"
	WHERE "images"."id" = "admin_users"."avatar_image_id";
END
$$;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_uploaded_by_user_id_admin_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_owner_avatar_only" CHECK ("images"."uploaded_by_user_id" is null or "images"."kind" = 'avatar');--> statement-breakpoint
CREATE INDEX "images_uploaded_by_kind_created_idx" ON "images" USING btree ("uploaded_by_user_id", "kind", "created_at") WHERE "images"."uploaded_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE FUNCTION "pulse_enforce_avatar_image_owner"() RETURNS trigger AS $$
DECLARE
	"image_kind" text;
	"image_owner_id" uuid;
BEGIN
	IF NEW."avatar_image_id" IS NULL
		OR NEW."avatar_image_id" IS NOT DISTINCT FROM OLD."avatar_image_id" THEN
		RETURN NEW;
	END IF;

	SELECT "kind", "uploaded_by_user_id"
	INTO "image_kind", "image_owner_id"
	FROM "images"
	WHERE "id" = NEW."avatar_image_id"
	FOR UPDATE;

	IF NOT FOUND THEN
		RAISE EXCEPTION 'avatar image does not exist';
	END IF;

	IF "image_kind" <> 'avatar' THEN
		RAISE EXCEPTION 'avatar reference points to a non-avatar image';
	END IF;

	IF "image_owner_id" IS NULL THEN
		UPDATE "images"
		SET "uploaded_by_user_id" = NEW."id"
		WHERE "id" = NEW."avatar_image_id";
	ELSIF "image_owner_id" <> NEW."id" THEN
		RAISE EXCEPTION 'avatar image belongs to another user';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "enforce_avatar_image_owner"
BEFORE UPDATE OF "avatar_image_id" ON "admin_users"
FOR EACH ROW EXECUTE FUNCTION "pulse_enforce_avatar_image_owner"();
