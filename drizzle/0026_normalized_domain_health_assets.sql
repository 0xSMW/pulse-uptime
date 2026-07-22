CREATE TABLE "certificate_health_assets" (
	"hostname" text NOT NULL,
	"port" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"issuer" text,
	"checked_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_referenced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "certificate_health_assets_hostname_port_pk" PRIMARY KEY("hostname","port"),
	CONSTRAINT "certificate_health_assets_port" CHECK ("certificate_health_assets"."port" between 1 and 65535)
);
--> statement-breakpoint
CREATE TABLE "domain_health_assets" (
	"apex_domain" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone,
	"registrar" text,
	"checked_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_referenced_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE FUNCTION "pulse_mirror_monitor_domain_health"() RETURNS trigger AS $$
BEGIN
	IF NEW."apex_domain" IS NOT NULL THEN
		INSERT INTO "domain_health_assets" (
			"apex_domain", "expires_at", "registrar", "checked_at",
			"last_success_at", "last_referenced_at"
		) VALUES (
			NEW."apex_domain", NEW."domain_expires_at", NEW."domain_registrar",
			NEW."checked_at",
			CASE WHEN NEW."domain_expires_at" IS NOT NULL OR NEW."domain_registrar" IS NOT NULL
				THEN NEW."checked_at" ELSE NULL END,
			CURRENT_TIMESTAMP
		)
		ON CONFLICT ("apex_domain") DO UPDATE SET
			"expires_at" = coalesce(EXCLUDED."expires_at", "domain_health_assets"."expires_at"),
			"registrar" = coalesce(EXCLUDED."registrar", "domain_health_assets"."registrar"),
			"checked_at" = EXCLUDED."checked_at",
			"last_success_at" = coalesce(EXCLUDED."last_success_at", "domain_health_assets"."last_success_at"),
			"last_referenced_at" = EXCLUDED."last_referenced_at"
		WHERE "domain_health_assets"."checked_at" IS NULL
			OR EXCLUDED."checked_at" >= "domain_health_assets"."checked_at";
	END IF;

	IF NEW."cert_port" IS NOT NULL THEN
		INSERT INTO "certificate_health_assets" (
			"hostname", "port", "expires_at", "issuer", "checked_at",
			"last_success_at", "last_referenced_at"
		) VALUES (
			NEW."hostname", NEW."cert_port", NEW."cert_expires_at", NEW."cert_issuer",
			NEW."checked_at",
			CASE WHEN NEW."cert_expires_at" IS NOT NULL OR NEW."cert_issuer" IS NOT NULL
				THEN NEW."checked_at" ELSE NULL END,
			CURRENT_TIMESTAMP
		)
		ON CONFLICT ("hostname", "port") DO UPDATE SET
			"expires_at" = coalesce(EXCLUDED."expires_at", "certificate_health_assets"."expires_at"),
			"issuer" = coalesce(EXCLUDED."issuer", "certificate_health_assets"."issuer"),
			"checked_at" = EXCLUDED."checked_at",
			"last_success_at" = coalesce(EXCLUDED."last_success_at", "certificate_health_assets"."last_success_at"),
			"last_referenced_at" = EXCLUDED."last_referenced_at"
		WHERE "certificate_health_assets"."checked_at" IS NULL
			OR EXCLUDED."checked_at" >= "certificate_health_assets"."checked_at";
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "mirror_monitor_domain_health"
AFTER INSERT OR UPDATE ON "monitor_domain_health"
FOR EACH ROW EXECUTE FUNCTION "pulse_mirror_monitor_domain_health"();
--> statement-breakpoint
INSERT INTO "domain_health_assets" (
	"apex_domain", "expires_at", "registrar", "checked_at",
	"last_success_at", "last_referenced_at"
)
SELECT
	"apex_domain",
	(array_agg("domain_expires_at" ORDER BY "checked_at" DESC, "monitor_id" ASC)
		FILTER (WHERE "domain_expires_at" IS NOT NULL))[1],
	(array_agg("domain_registrar" ORDER BY "checked_at" DESC, "monitor_id" ASC)
		FILTER (WHERE "domain_registrar" IS NOT NULL))[1],
	max("checked_at"), NULL, CURRENT_TIMESTAMP
FROM "monitor_domain_health"
WHERE "apex_domain" IS NOT NULL
GROUP BY "apex_domain";
--> statement-breakpoint
INSERT INTO "certificate_health_assets" (
	"hostname", "port", "expires_at", "issuer", "checked_at",
	"last_success_at", "last_referenced_at"
)
SELECT
	"hostname", "cert_port",
	(array_agg("cert_expires_at" ORDER BY "checked_at" DESC, "monitor_id" ASC)
		FILTER (WHERE "cert_expires_at" IS NOT NULL))[1],
	(array_agg("cert_issuer" ORDER BY "checked_at" DESC, "monitor_id" ASC)
		FILTER (WHERE "cert_issuer" IS NOT NULL))[1],
	max("checked_at"), NULL, CURRENT_TIMESTAMP
FROM "monitor_domain_health"
WHERE "cert_port" IS NOT NULL
GROUP BY "hostname", "cert_port";
--> statement-breakpoint
CREATE INDEX "certificate_health_assets_last_referenced" ON "certificate_health_assets" USING btree ("last_referenced_at");--> statement-breakpoint
CREATE INDEX "domain_health_assets_last_referenced" ON "domain_health_assets" USING btree ("last_referenced_at");
