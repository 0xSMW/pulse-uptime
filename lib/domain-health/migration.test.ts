import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

const migrationPath = new URL(
  "../../drizzle/0026_normalized_domain_health_assets.sql",
  import.meta.url
)

describe("normalized domain health migration", () => {
  it("backfills newest non-null shared facts and retains the legacy table", async () => {
    const migration = await readFile(migrationPath, "utf8")

    expect(migration).toContain('INSERT INTO "domain_health_assets"')
    expect(migration).toContain('INSERT INTO "certificate_health_assets"')
    expect(migration).toContain('CREATE TRIGGER "mirror_monitor_domain_health"')
    expect(migration.indexOf("CREATE TRIGGER")).toBeLessThan(
      migration.indexOf('INSERT INTO "domain_health_assets" (\n\t"apex_domain"')
    )
    expect(migration).toContain(
      'array_agg("domain_expires_at" ORDER BY "checked_at" DESC'
    )
    expect(migration).toContain(
      'array_agg("cert_issuer" ORDER BY "checked_at" DESC'
    )
    expect(migration).toContain('GROUP BY "apex_domain"')
    expect(migration).toContain('GROUP BY "hostname", "cert_port"')
    expect(migration).toContain("CURRENT_TIMESTAMP")
    expect(migration).not.toContain('DROP TABLE "monitor_domain_health"')
  })
})
