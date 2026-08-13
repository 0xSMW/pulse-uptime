import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

const migrationPath = new URL(
  "../../drizzle/0031_credential_epoch.sql",
  import.meta.url
)

describe("credential epoch migration", () => {
  it("seeds human and CLI roots before recursively backfilling token descendants", async () => {
    const migration = await readFile(migrationPath, "utf8")
    const humanRoot = migration.indexOf(
      `WHERE token."principal_type" = 'human'`
    )
    const cliRoot = migration.indexOf(
      `WHERE token."principal_type" = 'cli_session'`
    )
    const recursiveDescendants = migration.indexOf(
      "WITH RECURSIVE token_owners"
    )

    expect(humanRoot).toBeGreaterThan(-1)
    expect(cliRoot).toBeGreaterThan(humanRoot)
    expect(recursiveDescendants).toBeGreaterThan(cliRoot)
    expect(migration).toContain(`FROM "admin_users" AS users`)
    expect(migration).toContain(`AND token."principal_id" = users."id"::text`)
    expect(migration).not.toContain(
      `SET "credential_owner_user_id" = "principal_id"::uuid`
    )
    expect(migration).toContain(
      `JOIN token_owners AS parent ON child."principal_type" = 'api_token'`
    )
    expect(migration).toContain(`AND child."principal_id" = parent."id"::text`)
  })

  it("copies the resolved owner epoch onto every token and installation", async () => {
    const migration = await readFile(migrationPath, "utf8")

    expect(migration).toContain(
      `SET "credential_epoch" = users."credential_epoch"`
    )
    expect(migration).toContain(`"credential_epoch" = users."credential_epoch"`)
  })

  it("enforces rotation for old application instances at the database boundary", async () => {
    const migration = await readFile(migrationPath, "utf8")

    expect(migration).toContain(
      `CREATE FUNCTION "pulse_lock_machine_credentials"`
    )
    expect(migration).toContain(
      "pg_advisory_xact_lock(hashtext('pulse:machine-credentials'))"
    )
    expect(migration).toContain("FOR EACH STATEMENT")
    expect(migration).toContain(
      `CREATE FUNCTION "pulse_advance_credential_epoch"`
    )
    expect(migration).toContain(`BEFORE UPDATE OF "password_digest"`)
    expect(migration).toContain(
      `NEW."credential_epoch" := OLD."credential_epoch" + 1`
    )
    expect(migration).toContain(
      `CREATE FUNCTION "pulse_revoke_rotated_credentials"`
    )
    expect(migration).toContain(`AFTER UPDATE OF "password_digest"`)
    expect(migration).toContain("WITH RECURSIVE token_tree")
  })
})
