import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/db/client", () => ({ db: {} }))

import { reconcileDomainHealthAssets } from "./store"

function renderSql(value: unknown): string {
  return new PgDialect().sqlToQuery(value as never).sql
}

function fakeHandle(
  monitors: Array<{ id: string; url: string }> = [
    { id: "one", url: "https://status.example.com" },
  ]
) {
  const conflictCalls: unknown[] = []
  const deleteWhereCalls: unknown[] = []
  const valuesCalls: unknown[] = []
  const tx = {
    execute: vi.fn(async () => undefined),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => monitors),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values) => {
        valuesCalls.push(values)
        return {
          onConflictDoUpdate: vi.fn((options) => {
            conflictCalls.push(options)
          }),
        }
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn((condition) => {
        deleteWhereCalls.push(condition)
      }),
    })),
  }
  return {
    handle: {
      transaction: (callback: (value: typeof tx) => unknown) => callback(tx),
    },
    conflictCalls,
    deleteWhereCalls,
    valuesCalls,
    tx,
  }
}

describe("reconcileDomainHealthAssets", () => {
  it("preserves non-null facts while recording the refresh attempt", async () => {
    const { handle, conflictCalls } = fakeHandle()
    const referencedAt = new Date("2026-07-22T00:00:00Z")
    await reconcileDomainHealthAssets(
      {
        domains: [
          {
            apexDomain: "example.com",
            expiresAt: null,
            registrar: null,
            checkedAt: referencedAt,
          },
        ],
        certificates: [
          {
            hostname: "status.example.com",
            port: 443,
            expiresAt: null,
            issuer: null,
            checkedAt: referencedAt,
          },
        ],
        referencedAt,
        pruneBefore: new Date("2026-07-20T00:00:00Z"),
      },
      handle as never
    )

    const domainRefresh = conflictCalls[2] as { set: Record<string, unknown> }
    const certRefresh = conflictCalls[3] as { set: Record<string, unknown> }
    expect(renderSql(domainRefresh.set.expiresAt)).toContain(
      "coalesce(excluded.expires_at"
    )
    expect(renderSql(domainRefresh.set.checkedAt)).toBe("excluded.checked_at")
    expect(renderSql(certRefresh.set.issuer)).toContain(
      "coalesce(excluded.issuer"
    )
  })

  it("prunes only unreferenced assets older than the grace cutoff", async () => {
    const { handle, deleteWhereCalls } = fakeHandle()
    const referencedAt = new Date("2026-07-22T00:00:00Z")
    await reconcileDomainHealthAssets(
      {
        domains: [],
        certificates: [],
        referencedAt,
        pruneBefore: new Date("2026-07-20T00:00:00Z"),
      },
      handle as never
    )

    const domainPrune = renderSql(deleteWhereCalls[0])
    const certificatePrune = renderSql(deleteWhereCalls[1])
    expect(domainPrune).toContain('"last_referenced_at" < $1')
    expect(domainPrune).toContain('"apex_domain" not in ($2)')
    expect(certificatePrune).toContain('"last_referenced_at" < $1')
    expect(certificatePrune).toContain("not exists")
  })

  it("locks and rereads current monitor targets before reference cleanup", async () => {
    const { handle, valuesCalls, deleteWhereCalls, tx } = fakeHandle([
      { id: "restored", url: "https://restored.example.net:8443" },
    ])
    const referencedAt = new Date("2026-07-22T00:00:00Z")

    await reconcileDomainHealthAssets(
      {
        domains: [],
        certificates: [],
        referencedAt,
        pruneBefore: new Date("2026-07-20T00:00:00Z"),
      },
      handle as never
    )

    expect(tx.execute).toHaveBeenCalledOnce()
    expect(valuesCalls[0]).toEqual([
      expect.objectContaining({
        apexDomain: "example.net",
        lastReferencedAt: referencedAt,
      }),
    ])
    expect(valuesCalls[1]).toEqual([
      expect.objectContaining({
        hostname: "restored.example.net",
        port: 8443,
        lastReferencedAt: referencedAt,
      }),
    ])
    expect(renderSql(deleteWhereCalls[0])).toContain("not in")
    expect(renderSql(deleteWhereCalls[1])).toContain("not exists")
  })
})
