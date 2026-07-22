// biome-ignore-all lint/suspicious/noThenProperty: thenable mocks emulate Drizzle query builders
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: {} }))

import type { DatabaseHandle } from "@/lib/db/client"

import { createApiToken, TokenServiceError } from "./token-service"

const now = new Date("2026-07-22T00:00:00.000Z")
const expiresAt = new Date("2026-08-01T00:00:00.000Z")

function lockingHandle(parent: Record<string, unknown> | null) {
  const events: string[] = []
  let selectCalls = 0
  const inserted = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "child",
    scopes: ["monitors:read"],
    createdAt: now,
    expiresAt,
    lastUsedAt: null,
    revokedAt: null,
  }

  function query(result: unknown[]) {
    const chain: Record<string, unknown> = {}
    for (const method of ["from", "where", "limit", "innerJoin"]) {
      chain[method] = vi.fn(() => chain)
    }
    chain.for = vi.fn(() => {
      events.push("parent-lock")
      return chain
    })
    chain.then = (
      resolve: (value: unknown) => unknown,
      reject: (reason: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject)
    return chain
  }

  const tx = {
    execute: vi.fn(async () => {
      events.push("credential-lock")
    }),
    select: vi.fn(() => {
      const result = selectCalls === 0 && parent ? [parent] : []
      selectCalls += 1
      return query(result)
    }),
    insert: vi.fn(() => {
      events.push("insert")
      return {
        values: vi.fn(() => ({
          returning: vi.fn(async () => [inserted]),
        })),
      }
    }),
  }
  const handle = {
    transaction: vi.fn(async (work: (value: typeof tx) => unknown) => work(tx)),
  } as unknown as DatabaseHandle
  return { handle, events, tx }
}

describe("API token mint serialization", () => {
  it("revalidates the exact human session before inserting", async () => {
    const { handle, events } = lockingHandle({ role: "admin" })

    await createApiToken(
      {
        name: "dashboard token",
        scopes: ["monitors:read"],
        expiresAt,
        principal: {
          type: "human",
          id: "11111111-1111-4111-8111-111111111111",
          sessionId: "33333333-3333-4333-8333-333333333333",
        },
        credential: {
          raw: "pulse_live_human",
          prefix: "pulse_live_human",
          digest: Buffer.alloc(32, 2),
        },
      },
      now,
      handle
    )

    expect(events).toEqual(["credential-lock", "parent-lock", "insert"])
  })

  it("rejects a human token mint after session revocation", async () => {
    const { handle, events, tx } = lockingHandle(null)

    await expect(
      createApiToken(
        {
          name: "dashboard token",
          scopes: ["monitors:read"],
          expiresAt,
          principal: {
            type: "human",
            id: "11111111-1111-4111-8111-111111111111",
            sessionId: "33333333-3333-4333-8333-333333333333",
          },
        },
        now,
        handle
      )
    ).rejects.toBeInstanceOf(TokenServiceError)

    expect(events).toEqual(["credential-lock", "parent-lock"])
    expect(tx.insert).not.toHaveBeenCalled()
  })

  it("locks and re-reads the parent before inserting a child", async () => {
    const { handle, events } = lockingHandle({
      scopes: ["tokens:manage", "monitors:read"],
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    })

    await createApiToken(
      {
        name: "child",
        scopes: ["monitors:read"],
        expiresAt,
        principal: {
          type: "api_token",
          id: "11111111-1111-4111-8111-111111111111",
        },
        credential: {
          raw: "pulse_live_child",
          prefix: "pulse_live_child",
          digest: Buffer.alloc(32, 1),
        },
      },
      now,
      handle
    )

    expect(events).toEqual(["credential-lock", "parent-lock", "insert"])
  })

  it("fails closed when revocation wins before the parent lock", async () => {
    const { handle, events, tx } = lockingHandle(null)

    await expect(
      createApiToken(
        {
          name: "child",
          scopes: ["monitors:read"],
          expiresAt,
          principal: {
            type: "api_token",
            id: "11111111-1111-4111-8111-111111111111",
          },
        },
        now,
        handle
      )
    ).rejects.toBeInstanceOf(TokenServiceError)

    expect(events).toEqual(["credential-lock", "parent-lock"])
    expect(tx.insert).not.toHaveBeenCalled()
  })
})
