import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/db/client", () => ({ db: {} }))

import { upsertDomainHealth } from "./store"

function captureConflictSet(options?: { preserveCertFacts?: boolean }) {
  const onConflictDoUpdate = vi.fn()
  const handle = {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ onConflictDoUpdate })),
    })),
  }

  return upsertDomainHealth(
    [
      {
        monitorId: "monitor-1",
        hostname: "status.example.com",
        apexDomain: "example.com",
        certPort: 8443,
        certExpiresAt: null,
        certIssuer: null,
        domainExpiresAt: null,
        domainRegistrar: null,
        checkedAt: new Date("2026-07-22T00:00:00Z"),
      },
    ],
    options,
    handle as never
  ).then(() => onConflictDoUpdate.mock.calls[0]?.[0].set)
}

function renderSql(value: unknown): string {
  return new PgDialect().sqlToQuery(value as never).sql
}

describe("upsertDomainHealth", () => {
  it("preserves failed certificate facts only for the same hostname and port", async () => {
    const set = await captureConflictSet()

    expect(renderSql(set.certExpiresAt)).toContain(
      '"monitor_domain_health"."hostname" = excluded.hostname and "monitor_domain_health"."cert_port" = excluded.cert_port'
    )
    expect(renderSql(set.certExpiresAt)).toContain(
      "coalesce(excluded.cert_expires_at"
    )
    expect(renderSql(set.certIssuer)).toContain(
      '"monitor_domain_health"."cert_port" = excluded.cert_port'
    )
    expect(renderSql(set.certPort)).toBe("excluded.cert_port")
  })

  it("overwrites certificate facts for targets without TLS", async () => {
    const set = await captureConflictSet({ preserveCertFacts: false })

    expect(renderSql(set.certExpiresAt)).toBe("excluded.cert_expires_at")
    expect(renderSql(set.certIssuer)).toBe("excluded.cert_issuer")
  })
})
