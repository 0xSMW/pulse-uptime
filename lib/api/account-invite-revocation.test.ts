// biome-ignore-all lint/suspicious/noThenProperty: thenable mocks emulate Drizzle query builders

import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, it, vi } from "vitest"

const { dbMock } = vi.hoisted(() => ({
  dbMock: { select: vi.fn(), transaction: vi.fn() },
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: dbMock }))

import { adminUsers } from "@/lib/db/schema"
import { changeAccountEmail } from "./account"

const userId = "11111111-1111-4111-8111-111111111111"
const now = new Date("2026-11-14T00:00:00.000Z")

function emailChangeDatabase(updated: boolean) {
  const account = {
    email: "old@example.com",
    passwordDigest: "old-digest",
  }
  dbMock.select.mockReturnValue({
    from: () => ({
      where: () => ({ limit: async () => [account] }),
    }),
  })
  const execute = vi.fn(async (_statement: unknown) => undefined)
  let selectCalls = 0
  const tx = {
    execute,
    select: vi.fn(() => {
      selectCalls += 1
      const rows = [
        { id: selectCalls === 1 ? input.currentSessionId : "other-session-id" },
      ]
      return {
        from: () => ({
          where: () => ({
            for: () => ({
              limit: async () => rows,
              then: (resolve: (value: unknown) => unknown) =>
                Promise.resolve(rows).then(resolve),
            }),
          }),
        }),
      }
    }),
    update: vi.fn((table: unknown) => ({
      set: () => ({
        where: () => ({
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve([]).then(resolve),
          returning: async () =>
            table === adminUsers && updated ? [{ id: userId }] : [],
        }),
      }),
    })),
  }
  dbMock.transaction.mockImplementation(async (work) => work(tx))
  return { execute, tx }
}

const input = {
  userId,
  currentSessionId: "22222222-2222-4222-8222-222222222222",
  ip: "203.0.113.7",
  currentPassword: "correct password",
  email: "new@example.com",
  emailConfirm: "new@example.com",
}
const dependencies = {
  verify: async () => true,
  enforceLimit: async () => ({
    allowed: true,
    remaining: 4,
    retryAfterSeconds: 1,
  }),
  digestKey: (value: string) => Buffer.from(value),
  now: () => now,
}

describe("email-change invite revocation", () => {
  it("revokes pending invites in the successful email-change transaction", async () => {
    const { execute } = emailChangeDatabase(true)

    await expect(changeAccountEmail(input, dependencies)).resolves.toEqual({
      email: input.email,
    })

    const statements = execute.mock.calls.map(
      ([statement]) => new PgDialect().sqlToQuery(statement as never).sql
    )
    expect(
      statements.some((statement) => statement.includes("user_invites"))
    ).toBe(true)
  })

  it("leaves invites untouched when the email compare-and-set loses", async () => {
    const { execute } = emailChangeDatabase(false)

    await expect(changeAccountEmail(input, dependencies)).rejects.toMatchObject(
      {
        code: "ACCOUNT_CHANGED",
      }
    )
    const statements = execute.mock.calls.map(
      ([statement]) => new PgDialect().sqlToQuery(statement as never).sql
    )
    expect(
      statements.some((statement) => statement.includes("user_invites"))
    ).toBe(false)
  })
})
