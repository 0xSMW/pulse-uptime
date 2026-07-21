import { describe, expect, it } from "vitest";
import { validateDirectMigrationUrl } from "./database-url.mjs";

const SECRET = "s3cret-p@ss/w:ord";
const NEON_DIRECT =
  `postgresql://pulse_owner:${encodeURIComponent(SECRET)}@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const NEON_POOLER =
  `postgresql://pulse_owner:${encodeURIComponent(SECRET)}@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const SELF_HOSTED = `postgres://pulse:${encodeURIComponent(SECRET)}@db.internal.example:5432/pulse_prod`;

describe("validateDirectMigrationUrl", () => {
  it("accepts a direct Neon URL", () => {
    const result = validateDirectMigrationUrl(NEON_DIRECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hostname).toBe("ep-cool-name-123456.us-east-2.aws.neon.tech");
    expect(result.database).toBe("neondb");
    expect(result.connectionString).toBe(NEON_DIRECT);
    expect(result.url.protocol).toBe("postgresql:");
  });

  it("accepts a self-hosted direct PostgreSQL URL", () => {
    const result = validateDirectMigrationUrl(SELF_HOSTED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hostname).toBe("db.internal.example");
    expect(result.database).toBe("pulse_prod");
    expect(result.url.port).toBe("5432");
  });

  it("accepts the postgres: scheme", () => {
    const result = validateDirectMigrationUrl(
      "postgres://user:pass@localhost:5432/app",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hostname).toBe("localhost");
    expect(result.database).toBe("app");
  });

  it("rejects a Neon pooler hostname before any network use", () => {
    const result = validateDirectMigrationUrl(NEON_POOLER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pooler_hostname");
    expect(result.message.toLowerCase()).toMatch(/pooler/);
  });

  it("rejects pooler as the first hostname label", () => {
    const result = validateDirectMigrationUrl(
      "postgresql://u:p@pooler.db.example.com/app",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pooler_hostname");
  });

  it("rejects an explicit PgBouncer query setting", () => {
    const result = validateDirectMigrationUrl(
      "postgresql://u:p@ep-direct.us-east-2.aws.neon.tech/neondb?sslmode=require&pgbouncer=true",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pooler_options");
  });

  it("rejects pool_mode=transaction", () => {
    const result = validateDirectMigrationUrl(
      "postgresql://u:p@db.example.com/app?pool_mode=transaction",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pooler_options");
  });

  it("rejects pgbouncer mentioned in options=", () => {
    const result = validateDirectMigrationUrl(
      "postgresql://u:p@db.example.com/app?options=pgbouncer%3Dtrue",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pooler_options");
  });

  it("rejects an invalid URL", () => {
    const result = validateDirectMigrationUrl("not a url at all");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_url");
  });

  it("rejects an empty string", () => {
    const result = validateDirectMigrationUrl("");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_url");
  });

  it("rejects a non-postgres scheme", () => {
    const result = validateDirectMigrationUrl("https://db.example.com/app");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_scheme");
  });

  it("rejects a URL without a database name", () => {
    const noPath = validateDirectMigrationUrl(
      "postgresql://u:p@ep-direct.us-east-2.aws.neon.tech",
    );
    expect(noPath.ok).toBe(false);
    if (!noPath.ok) expect(noPath.code).toBe("missing_database");

    const slashOnly = validateDirectMigrationUrl(
      "postgresql://u:p@ep-direct.us-east-2.aws.neon.tech/",
    );
    expect(slashOnly.ok).toBe(false);
    if (!slashOnly.ok) expect(slashOnly.code).toBe("missing_database");
  });

  it("rejects a URL without a hostname", () => {
    const result = validateDirectMigrationUrl("postgresql:///neondb");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("missing_hostname");
  });

  it("success payload exposes only sanitized host and database for logging", () => {
    const result = validateDirectMigrationUrl(NEON_DIRECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const logShape = {
      hostname: result.hostname,
      database: result.database,
    };
    const serialized = JSON.stringify(logShape);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("pulse_owner");
    expect(serialized).not.toContain("sslmode");
    expect(serialized).toContain("ep-cool-name-123456.us-east-2.aws.neon.tech");
    expect(serialized).toContain("neondb");
  });

  it("error messages never include credentials", () => {
    const cases = [
      NEON_POOLER,
      `postgresql://pulse_owner:${encodeURIComponent(SECRET)}@ep-direct.us-east-2.aws.neon.tech/neondb?pgbouncer=true`,
      `postgresql://pulse_owner:${encodeURIComponent(SECRET)}@host/`,
      `mysql://pulse_owner:${encodeURIComponent(SECRET)}@host/db`,
    ];

    for (const input of cases) {
      const result = validateDirectMigrationUrl(input);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.message).not.toContain(SECRET);
      expect(result.message).not.toContain("pulse_owner");
      expect(result.message).not.toContain(encodeURIComponent(SECRET));
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });
});
