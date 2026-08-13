import { readFile } from "node:fs/promises"

import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import * as schema from "@/lib/db/schema"
import { revokeUserMachineCredentials } from "./credential-revocation"

const databaseUrl = process.env.TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip
const schemaName = `credential_epoch_${crypto.randomUUID().replaceAll("-", "")}`
const client = databaseUrl
  ? postgres(databaseUrl, {
      max: 3,
      prepare: false,
      connection: { search_path: schemaName },
    })
  : null

suite("credential epoch rolling deployment", () => {
  beforeAll(async () => {
    await client!.unsafe(`create schema "${schemaName}"`)
    await client!.unsafe(`
      create table admin_users (
        id uuid primary key,
        email text not null unique,
        password_digest text not null,
        password_changed_at timestamptz not null
      );
      create table human_sessions (
        id uuid primary key,
        user_id uuid not null references admin_users(id),
        revoked_at timestamptz
      );
      create table api_tokens (
        id uuid primary key,
        principal_type text not null,
        principal_id text not null,
        created_by_principal text not null,
        revoked_at timestamptz
      );
      create table cli_installations (
        id uuid primary key,
        user_email text not null,
        revoked_at timestamptz
      );
      create table cli_sessions (
        id uuid primary key,
        installation_id uuid not null references cli_installations(id),
        user_email text not null,
        revoked_at timestamptz
      );
    `)
  })

  afterAll(async () => {
    if (client) {
      await client.unsafe(`drop schema if exists "${schemaName}" cascade`)
      await client.end()
    }
  })

  it("invalidates old credentials when an old release changes the password", async () => {
    const userId = "11111111-1111-4111-8111-111111111111"
    const sessionId = "22222222-2222-4222-8222-222222222222"
    const installationId = "33333333-3333-4333-8333-333333333333"
    const cliSessionId = "44444444-4444-4444-8444-444444444444"
    const tokenIds = [
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
      "77777777-7777-4777-8777-777777777777",
      "88888888-8888-4888-8888-888888888888",
    ]
    const rotatedAt = new Date("2026-08-13T00:00:00Z")
    await client!`
      insert into admin_users (id, email, password_digest, password_changed_at)
      values (${userId}, 'owner@example.com', 'old-digest', ${new Date("2026-08-12T00:00:00Z")})
    `
    await client!`
      insert into human_sessions (id, user_id) values (${sessionId}, ${userId})
    `
    await client!`
      insert into cli_installations (id, user_email)
      values (${installationId}, 'owner@example.com')
    `
    await client!`
      insert into cli_sessions (id, installation_id, user_email)
      values (${cliSessionId}, ${installationId}, 'owner@example.com')
    `
    await client!`
      insert into api_tokens (id, principal_type, principal_id, created_by_principal)
      values
        (${tokenIds[0]!}, 'human', ${userId}, ${`human:${userId}`}),
        (${tokenIds[1]!}, 'api_token', ${tokenIds[0]!}, ${`api_token:${tokenIds[0]}`}),
        (${tokenIds[2]!}, 'cli_session', ${cliSessionId}, ${`cli_session:${cliSessionId}`}),
        (${tokenIds[3]!}, 'api_token', ${tokenIds[2]!}, ${`api_token:${tokenIds[2]}`})
    `

    const source = (
      await readFile(
        new URL("../../drizzle/0031_credential_epoch.sql", import.meta.url),
        "utf8"
      )
    ).replaceAll('"public".', `"${schemaName}".`)
    for (const statement of source
      .split("--> statement-breakpoint")
      .map((part) => part.trim())
      .filter(Boolean)) {
      await client!.unsafe(statement)
    }

    // This is the pre-epoch application behavior. Database triggers installed
    // before the new artifact must still invalidate every machine credential.
    await client!`
      update admin_users
      set password_digest = 'new-digest', password_changed_at = ${rotatedAt}
      where id = ${userId}
    `

    const [user] = await client!`
      select credential_epoch from admin_users where id = ${userId}
    `
    const tokens = await client!`
      select id, revoked_at from api_tokens order by id
    `
    const [installation] = await client!`
      select revoked_at from cli_installations where id = ${installationId}
    `
    const [cliSession] = await client!`
      select revoked_at from cli_sessions where id = ${cliSessionId}
    `

    expect(user?.credential_epoch).toBe(1)
    expect(tokens).toHaveLength(4)
    expect(tokens.every((token) => token.revoked_at instanceof Date)).toBe(true)
    expect(installation?.revoked_at).toBeInstanceOf(Date)
    expect(cliSession?.revoked_at).toBeInstanceOf(Date)
  })

  it("serializes password rotation with a legacy delegated mint", async () => {
    const userId = "99999999-9999-4999-8999-999999999999"
    const parentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    await client!`
      insert into admin_users (id, email, password_digest, password_changed_at)
      values (${userId}, 'race@example.com', 'old-digest', now())
    `
    await client!`
      insert into api_tokens (
        id,
        principal_type,
        principal_id,
        created_by_principal,
        credential_owner_user_id,
        credential_epoch
      ) values (${parentId}, 'human', ${userId}, ${`human:${userId}`}, ${userId}, 0)
    `

    let releaseMint!: () => void
    const mintCanCommit = new Promise<void>((resolve) => {
      releaseMint = resolve
    })
    let markMintLocked!: () => void
    const mintLocked = new Promise<void>((resolve) => {
      markMintLocked = resolve
    })
    const mint = client!.begin(async (tx) => {
      await tx.unsafe(
        "select pg_advisory_xact_lock(hashtext('pulse:machine-credentials'))"
      )
      markMintLocked()
      await mintCanCommit
      await tx`
        insert into api_tokens (
          id,
          principal_type,
          principal_id,
          created_by_principal,
          credential_owner_user_id,
          credential_epoch
        ) values (${childId}, 'api_token', ${parentId}, ${`api_token:${parentId}`}, ${userId}, 0)
      `
    })
    await mintLocked

    let rotationFinished = false
    const rotation = client!`
      update admin_users
      set password_digest = 'new-digest', password_changed_at = now()
      where id = ${userId}
    `.then(() => {
      rotationFinished = true
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(rotationFinished).toBe(false)

    releaseMint()
    await mint
    await rotation

    const [child] = await client!`
      select revoked_at from api_tokens where id = ${childId}
    `
    expect(child?.revoked_at).toBeInstanceOf(Date)
  })

  it("executes application revocation timestamps through Postgres.js", async () => {
    const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    const tokenId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    const now = new Date("2026-08-13T07:00:00.000Z")
    await client!`
      insert into admin_users (id, email, password_digest, password_changed_at)
      values (${userId}, 'runtime@example.com', 'digest', ${now})
    `
    await client!`
      insert into api_tokens (
        id,
        principal_type,
        principal_id,
        created_by_principal,
        credential_owner_user_id,
        credential_epoch
      ) values (${tokenId}, 'human', ${userId}, ${`human:${userId}`}, ${userId}, 0)
    `

    const handle = drizzle(client!, { schema })
    await handle.transaction((tx) =>
      revokeUserMachineCredentials(tx, {
        userId,
        userEmail: "runtime@example.com",
        now,
      })
    )

    const [token] = await client!`
      select revoked_at from api_tokens where id = ${tokenId}
    `
    expect(new Date(token!.revoked_at as string)).toEqual(now)
  })
})
