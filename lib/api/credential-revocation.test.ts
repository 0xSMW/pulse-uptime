import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import type { DatabaseTransaction } from "@/lib/db/client"

import {
  revokeApiTokenSubtree,
  revokeCliTokenSubtrees,
  revokeUserMachineCredentials,
} from "./credential-revocation"

const dialect = new PgDialect()

function renderedSql(statement: unknown): string {
  return dialect.sqlToQuery(statement as never).sql.replace(/\s+/g, " ")
}

function renderedParams(statement: unknown): unknown[] {
  return dialect.sqlToQuery(statement as never).params
}

function transactionWithNoInstallations() {
  const execute = vi.fn().mockResolvedValue(undefined)
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn().mockResolvedValue([]),
    })),
  }))
  const update = vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  }))
  return {
    execute,
    tx: { execute, select, update } as unknown as DatabaseTransaction,
  }
}

describe("machine credential tree revocation", () => {
  it("revokes user-owned, human-rooted, and CLI-rooted token descendants", async () => {
    const { execute, tx } = transactionWithNoInstallations()

    await revokeUserMachineCredentials(tx, {
      userId: "11111111-1111-4111-8111-111111111111",
      userEmail: "owner@example.com",
      now: new Date("2026-08-13T00:00:00Z"),
    })

    const query = renderedSql(execute.mock.calls[0]![0])
    expect(query).toContain("with recursive token_tree")
    expect(query).toContain("credential_owner_user_id")
    expect(query).toContain("created_by_principal")
    expect(query).toContain("cli_session:")
    expect(query).toContain("api_token:")
  })

  it("revokes an API token subtree at arbitrary depth", async () => {
    const execute = vi.fn().mockResolvedValue([{ id: "child" }])
    const tx = { execute } as unknown as DatabaseTransaction

    const revoked = await revokeApiTokenSubtree(
      tx,
      "11111111-1111-4111-8111-111111111111",
      new Date("2026-08-13T00:00:00Z")
    )

    const query = renderedSql(execute.mock.calls[0]![0])
    expect(query).toContain("with recursive token_tree")
    expect(query).toContain("api_token:")
    expect(query).toContain("inner join token_tree")
    expect(revoked).toBe(1)
  })

  it("revokes every descendant of CLI-session token roots", async () => {
    const execute = vi.fn().mockResolvedValue([{ id: "grandchild" }])
    const tx = { execute } as unknown as DatabaseTransaction

    const revoked = await revokeCliTokenSubtrees(
      tx,
      ["11111111-1111-4111-8111-111111111111"],
      new Date("2026-08-13T00:00:00Z")
    )

    const query = renderedSql(execute.mock.calls[0]![0])
    expect(query).toContain("with recursive token_tree")
    expect(renderedParams(execute.mock.calls[0]![0])).toContain(
      "cli_session:11111111-1111-4111-8111-111111111111"
    )
    expect(query).toContain("api_token:")
    expect(revoked).toBe(1)
  })
})
