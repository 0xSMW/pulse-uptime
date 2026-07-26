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

import {
  claimPendingPorkbunWebhookReceipts,
  markPorkbunWebhookReceiptFailed,
  markPorkbunWebhookReceiptProcessed,
  PorkbunWebhookReplayMismatchError,
  PorkbunWebhookStore,
  readPorkbunIntegration,
  readPorkbunWebhookSigningSecret,
  upsertPorkbunIntegration,
} from "./store"

const databaseUrl = process.env.TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip
const signingSecret = "postgres-webhook-signing-secret"
const encryptionKey = "postgres-test-key-with-at-least-32-characters"

suite("Porkbun webhook PostgreSQL persistence", () => {
  const client = postgres(databaseUrl!, { max: 1, prepare: false })
  const db = drizzle(client, { schema })
  const receivedAt = new Date("2026-07-26T00:00:00.000Z")
  const record = {
    event: "domain.renewed" as const,
    eventCreatedAt: "2026-07-25T23:00:00.000Z",
    eventId: "evt-postgres-1",
    domain: "example.com",
    expireDate: "2027-07-25",
    payloadDigest: "digest-postgres-1",
  }

  beforeAll(async () => {
    // TEST_DATABASE_URL must point at an isolated database. Recreating public
    // keeps migration application and re-runs independent of prior test state.
    await client.unsafe("drop schema if exists public cascade")
    await client.unsafe("create schema public")
    const directory = resolvePath(process.cwd(), "drizzle")
    const migrations = (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort()
    for (const migration of migrations) {
      const source = await readFile(resolvePath(directory, migration), "utf8")
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
    vi.stubEnv("API_TOKEN_HASH_KEY", encryptionKey)
    await client`delete from porkbun_webhook_receipts`
    await client`delete from porkbun_integration`
  })

  it("round-trips an encrypted signing secret without exposing ciphertext in state", async () => {
    const state = await upsertPorkbunIntegration(
      {
        coveredDomainCount: 2,
        webhookId: 42,
        webhookSecret: signingSecret,
        webhookStatus: "ACTIVE",
        webhookUrl: "https://pulse.example/api/webhooks/porkbun",
      },
      { handle: db, now: receivedAt }
    )

    expect(state).toMatchObject({
      coveredDomainCount: 2,
      webhookId: 42,
      webhookStatus: "ACTIVE",
    })
    expect(state).not.toHaveProperty("webhookSecretEncrypted")
    expect(state).not.toHaveProperty("webhookSecret")
    expect(await readPorkbunIntegration(db)).toEqual(state)
    expect(await readPorkbunWebhookSigningSecret(db)).toBe(signingSecret)

    const [persisted] = await db
      .select({ encrypted: schema.porkbunIntegration.webhookSecretEncrypted })
      .from(schema.porkbunIntegration)
      .where(eq(schema.porkbunIntegration.id, "default"))
    expect(persisted?.encrypted).toMatch(
      /^v1:[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+){2}$/
    )
    expect(persisted?.encrypted).not.toContain(signingSecret)
  })

  it("persists duplicate receipts, rejects mismatched replays, and maps claimed rows", async () => {
    let clock = receivedAt
    const store = new PorkbunWebhookStore(db, () => clock)

    expect(await store.record(record)).toEqual({ duplicate: false })
    expect(await store.record(record)).toEqual({ duplicate: true })
    await expect(
      store.record({ ...record, payloadDigest: "digest-postgres-mismatch" })
    ).rejects.toBeInstanceOf(PorkbunWebhookReplayMismatchError)

    clock = new Date(receivedAt.getTime() + 1000)
    await store.record({
      ...record,
      eventId: "evt-postgres-2",
      payloadDigest: "digest-postgres-2",
    })
    expect(
      await db
        .select({ eventId: schema.porkbunWebhookReceipts.eventId })
        .from(schema.porkbunWebhookReceipts)
    ).toHaveLength(2)

    const claimAt = new Date(receivedAt.getTime() + 2000)
    const claimed = await claimPendingPorkbunWebhookReceipts(
      {
        limit: 2,
        now: claimAt,
        staleBefore: new Date(receivedAt.getTime() - 1),
      },
      db
    )
    expect(claimed).toEqual([
      {
        ...record,
        attemptCount: 1,
        processingStartedAt: claimAt,
        receivedAt,
      },
      {
        ...record,
        attemptCount: 1,
        eventId: "evt-postgres-2",
        payloadDigest: "digest-postgres-2",
        processingStartedAt: claimAt,
        receivedAt: clock,
      },
    ])

    expect(
      await markPorkbunWebhookReceiptProcessed(claimed[0]!, {
        handle: db,
        now: new Date(claimAt.getTime() + 1000),
      })
    ).toBe(true)
    expect(
      await markPorkbunWebhookReceiptFailed(claimed[1]!, "PROVIDER_ERROR", db)
    ).toBe(true)

    const [processed, failed] = await db
      .select()
      .from(schema.porkbunWebhookReceipts)
      .orderBy(schema.porkbunWebhookReceipts.eventId)
    expect(processed).toMatchObject({
      attemptCount: 1,
      eventId: "evt-postgres-1",
      lastErrorCode: null,
    })
    expect(processed?.processedAt).toBeInstanceOf(Date)
    expect(failed).toMatchObject({
      attemptCount: 1,
      eventId: "evt-postgres-2",
      lastErrorCode: "PROVIDER_ERROR",
      processedAt: null,
      processingStartedAt: null,
    })

    const [reclaimed] = await claimPendingPorkbunWebhookReceipts(
      {
        limit: 1,
        now: new Date(claimAt.getTime() + 2000),
        staleBefore: claimAt,
      },
      db
    )
    expect(reclaimed).toMatchObject({
      attemptCount: 2,
      eventId: "evt-postgres-2",
    })
    expect(
      await markPorkbunWebhookReceiptProcessed(reclaimed!, { handle: db })
    ).toBe(true)
    const [reprocessed] = await db
      .select({
        attemptCount: schema.porkbunWebhookReceipts.attemptCount,
        lastErrorCode: schema.porkbunWebhookReceipts.lastErrorCode,
        processedAt: schema.porkbunWebhookReceipts.processedAt,
      })
      .from(schema.porkbunWebhookReceipts)
      .where(eq(schema.porkbunWebhookReceipts.eventId, "evt-postgres-2"))
    expect(reprocessed).toMatchObject({ attemptCount: 2, lastErrorCode: null })
    expect(reprocessed?.processedAt).toBeInstanceOf(Date)
  })
})
