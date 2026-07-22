import { readdir, readFile } from "node:fs/promises"
import { resolve as resolvePath } from "node:path"

import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

vi.mock("server-only", () => ({}))

import * as schema from "@/lib/db/schema"

import { reconcileDomainHealthAssets } from "./store"

const databaseUrl = process.env.TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip

suite("domain health reconciliation against PostgreSQL", () => {
  const client = postgres(databaseUrl!, { max: 1, prepare: false })
  const db = drizzle(client, { schema })

  const now = new Date()
  const staleReference = new Date(now.getTime() - 72 * 60 * 60 * 1000)
  const pruneBefore = new Date(now.getTime() - 48 * 60 * 60 * 1000)

  // Applying every migration over a remote connection can far exceed the
  // default 10s hook budget.
  beforeAll(async () => {
    // Fresh schema so re-runs on a shared TEST_DATABASE_URL do not trip
    // "relation already exists" from earlier migration applications.
    await client.unsafe("drop schema if exists public cascade")
    await client.unsafe("create schema public")
    const dir = resolvePath(process.cwd(), "drizzle")
    const files = (await readdir(dir))
      .filter((name) => name.endsWith(".sql"))
      .sort()
    for (const migration of files) {
      const source = await readFile(resolvePath(dir, migration), "utf8")
      for (const statement of source
        .split("--> statement-breakpoint")
        .map((item) => item.trim())
        .filter(Boolean)) {
        await client.unsafe(statement)
      }
    }
  }, 120_000)

  afterAll(async () => {
    await client.end({ timeout: 5 })
  })

  beforeEach(async () => {
    await client`delete from monitor_domain_health`
    await client`delete from certificate_health_assets`
    await client`delete from domain_health_assets`
    await client`delete from monitor_exceptions`
    await client`delete from monitor_state`
    await client`delete from monitor_registry`
    await db.insert(schema.monitorRegistry).values([
      {
        id: "dh-current",
        name: "Current",
        url: "https://current.example.com/health",
        enabled: true,
        configHash: "dh-hash",
        firstSeenAt: now,
        lastSeenAt: now,
      },
    ])
  }, 30_000)

  it("prunes stale certificate assets without a type error and keeps referenced ones", async () => {
    // A stale asset for a hostname no longer in the accepted configuration and
    // a stale asset for the still-referenced hostname. The pruned set must be
    // exactly the unreferenced one. Before the ::int cast on the VALUES port
    // this DELETE failed with 42883 (text = integer) and rolled back the run.
    await db.insert(schema.certificateHealthAssets).values([
      {
        hostname: "gone.example.com",
        port: 443,
        expiresAt: null,
        issuer: null,
        checkedAt: staleReference,
        lastSuccessAt: null,
        lastReferencedAt: staleReference,
      },
      {
        hostname: "current.example.com",
        port: 443,
        expiresAt: null,
        issuer: null,
        checkedAt: staleReference,
        lastSuccessAt: null,
        lastReferencedAt: staleReference,
      },
    ])

    await reconcileDomainHealthAssets(
      {
        domains: [],
        certificates: [
          {
            hostname: "current.example.com",
            port: 443,
            expiresAt: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000),
            issuer: "Test CA",
            checkedAt: now,
          },
        ],
        referencedAt: now,
        pruneBefore,
      },
      db
    )

    const remaining = await db
      .select({
        hostname: schema.certificateHealthAssets.hostname,
        issuer: schema.certificateHealthAssets.issuer,
      })
      .from(schema.certificateHealthAssets)
    expect(remaining).toEqual([
      { hostname: "current.example.com", issuer: "Test CA" },
    ])
  }, 30_000)

  it("persists collected facts in the same transaction as the cleanup", async () => {
    // The production symptom: cleanup threw, the transaction rolled back, and
    // collected facts vanished with it. A successful reconcile must leave the
    // refreshed facts visible.
    await reconcileDomainHealthAssets(
      {
        domains: [
          {
            apexDomain: "example.com",
            expiresAt: new Date(now.getTime() + 89 * 24 * 60 * 60 * 1000),
            registrar: "Test Registrar",
            checkedAt: now,
          },
        ],
        certificates: [
          {
            hostname: "current.example.com",
            port: 443,
            expiresAt: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000),
            issuer: "Test CA",
            checkedAt: now,
          },
        ],
        referencedAt: now,
        pruneBefore,
      },
      db
    )

    const [domain] = await db
      .select({ registrar: schema.domainHealthAssets.registrar })
      .from(schema.domainHealthAssets)
      .where(eq(schema.domainHealthAssets.apexDomain, "example.com"))
    expect(domain?.registrar).toBe("Test Registrar")
    const [certificate] = await db
      .select({ issuer: schema.certificateHealthAssets.issuer })
      .from(schema.certificateHealthAssets)
      .where(eq(schema.certificateHealthAssets.hostname, "current.example.com"))
    expect(certificate?.issuer).toBe("Test CA")
  }, 30_000)
})
