import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

const migrationPath = new URL(
  "../../drizzle/0030_image_avatar_ownership.sql",
  import.meta.url
)

describe("image ownership migration", () => {
  it("keeps transaction-only locks inside an executable migration chunk", async () => {
    const migration = await readFile(migrationPath, "utf8")
    const chunks = migration
      .split("--> statement-breakpoint")
      .map((chunk) => chunk.trim())
      .filter(Boolean)
    const lockChunks = chunks.filter((chunk) => chunk.includes("LOCK TABLE"))

    expect(lockChunks).toHaveLength(1)
    expect(lockChunks[0]).toMatch(/^DO \$\$/)
    expect(lockChunks[0]).toContain(
      'LOCK TABLE "admin_users" IN SHARE ROW EXCLUSIVE MODE;'
    )
    expect(lockChunks[0]).toContain('UPDATE "admin_users"')
    expect(lockChunks[0]).toContain('UPDATE "images"')
    expect(chunks).not.toContain(
      'LOCK TABLE "admin_users" IN SHARE ROW EXCLUSIVE MODE;'
    )
  })
})
