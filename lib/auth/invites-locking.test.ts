// biome-ignore-all lint/suspicious/noThenProperty: thenable mocks emulate Drizzle query builders

import { beforeEach, describe, expect, it, vi } from "vitest"

const { dbMock } = vi.hoisted(() => ({
  dbMock: { transaction: vi.fn() },
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: dbMock }))
vi.mock("@/lib/analytics-server", () => ({ trackEvent: vi.fn() }))

import { changeUserRole, createUserInvite, removeUser } from "./invites"

const now = new Date("2026-11-14T00:00:00.000Z")
const actor = {
  type: "human" as const,
  id: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  email: "former-admin@example.com",
  role: "admin" as const,
  scopes: ["users:manage" as const],
}

beforeEach(() => {
  vi.stubEnv("API_TOKEN_HASH_KEY", "test-key-with-at-least-32-characters")
})

function actorHandle(currentActor: Record<string, unknown> | null = null) {
  const writes: string[] = []
  function query(result: unknown[]) {
    const chain: Record<string, unknown> = {}
    for (const method of ["from", "innerJoin", "where", "for", "limit"]) {
      chain[method] = vi.fn(() => chain)
    }
    chain.then = (
      resolve: (value: unknown) => unknown,
      reject: (reason: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject)
    return chain
  }
  const tx = {
    rollback: vi.fn(),
    execute: vi.fn(async () => undefined),
    select: vi.fn((columns: Record<string, unknown>) => {
      // The target remains a viewer, but the authenticated actor's human
      // session has already been demoted before this transaction begins.
      return query(
        "userId" in columns
          ? currentActor
            ? [currentActor]
            : []
          : [
              {
                id: "33333333-3333-4333-8333-333333333333",
                email: "target@example.com",
                role: "viewer",
              },
            ]
      )
    }),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => {
          writes.push("update")
          return []
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async () => {
        writes.push("insert")
      }),
    })),
  }
  dbMock.transaction.mockImplementation(async (work) => work(tx))
  return { tx, writes }
}

describe("team privilege mutations", () => {
  it("rejects a role change after the actor loses admin authority", async () => {
    const { writes } = actorHandle()
    const input = {
      userId: "33333333-3333-4333-8333-333333333333",
      role: "admin",
      actor,
    }

    await expect(changeUserRole(input, now)).rejects.toMatchObject({
      code: "ACTOR_DENIED",
    })
    expect(writes).toEqual([])
  })

  it("rejects an admin invite after the actor loses admin authority", async () => {
    const { tx, writes } = actorHandle()
    const input = {
      role: "admin" as const,
      createdByPrincipal: `human:${actor.id}`,
      actor,
    }

    await expect(
      createUserInvite(input, now, tx as never)
    ).rejects.toMatchObject({ code: "ACTOR_DENIED" })
    expect(writes).toEqual([])
  })

  it("creates an invite when the admin session is still active", async () => {
    const { tx, writes } = actorHandle({ userId: actor.id })
    const created = await createUserInvite(
      {
        role: "admin",
        createdByPrincipal: `human:${actor.id}`,
        actor,
      },
      now,
      tx as never
    )

    expect(created.role).toBe("admin")
    expect(tx.execute).toHaveBeenCalledTimes(2)
    expect(writes).toEqual(["insert"])
  })

  it("allows a role change while the admin session is still active", async () => {
    const { writes, tx } = actorHandle({ userId: actor.id })

    await expect(
      changeUserRole(
        {
          userId: "33333333-3333-4333-8333-333333333333",
          role: "admin",
          actor,
        },
        now
      )
    ).resolves.toMatchObject({ role: "admin" })
    expect(tx.execute).toHaveBeenCalledTimes(2)
    expect(writes).toEqual(["update"])
  })

  it("rejects a revoked API token or CLI session before changing roles", async () => {
    for (const staleActor of [
      {
        type: "api_token" as const,
        id: "44444444-4444-4444-8444-444444444444",
        name: "team token",
        scopes: ["users:manage" as const],
        expiresAt: new Date("2026-12-01T00:00:00.000Z"),
      },
      {
        type: "cli_session" as const,
        id: "55555555-5555-4555-8555-555555555555",
        email: actor.email,
        scopes: ["users:manage" as const],
        expiresAt: new Date("2026-12-01T00:00:00.000Z"),
        installation: {
          id: "66666666-6666-4666-8666-666666666666",
          displayName: "laptop",
          platform: "darwin",
          architecture: "arm64",
          clientVersion: "1.0.0",
          linkedAt: now,
        },
      },
    ]) {
      const { writes } = actorHandle()
      await expect(
        changeUserRole(
          {
            userId: "33333333-3333-4333-8333-333333333333",
            role: "admin",
            actor: staleActor,
          },
          now
        )
      ).rejects.toMatchObject({ code: "ACTOR_DENIED" })
      expect(writes).toEqual([])
    }
  })

  it("rejects removal after the admin session is revoked", async () => {
    const { writes } = actorHandle()
    await expect(
      removeUser(
        {
          userId: "33333333-3333-4333-8333-333333333333",
          actorUserId: actor.id,
          actor,
        },
        now
      )
    ).rejects.toMatchObject({ code: "ACTOR_DENIED" })
    expect(writes).toEqual([])
  })
})
