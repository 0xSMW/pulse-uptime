import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import * as schema from "@/lib/db/schema"
import { createApiToken, requireReplayableApiToken } from "./token-service"

const databaseUrl = process.env.TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip
const schemaName = `token_replay_${crypto.randomUUID().replaceAll("-", "")}`
const client = databaseUrl
  ? postgres(databaseUrl, {
      max: 2,
      prepare: false,
      connection: { search_path: schemaName },
    })
  : null

suite("token replay PostgreSQL authority", () => {
  beforeAll(async () => {
    await client!.unsafe(`create schema "${schemaName}"`)
    await client!.unsafe(`
      create table admin_users (
        id uuid primary key,
        role text not null,
        credential_epoch integer not null default 0
      );
      create table human_sessions (
        id uuid primary key,
        user_id uuid not null references admin_users(id),
        expires_at timestamptz not null,
        revoked_at timestamptz
      );
      create table api_tokens (
        id uuid primary key,
        name text not null default 'existing',
        token_prefix text not null default 'pulse_live',
        token_digest bytea not null default decode('00', 'hex'),
        principal_type text not null default 'human',
        principal_id text not null default '',
        scopes text[] not null default array['tokens:manage', 'monitors:read'],
        created_at timestamptz not null default now(),
        created_by_principal text not null,
        credential_owner_user_id uuid references admin_users(id),
        credential_epoch integer not null default 0,
        expires_at timestamptz not null,
        last_used_at timestamptz,
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

  it("rejects completed-secret replay after the creator session is revoked", async () => {
    const userId = crypto.randomUUID()
    const sessionId = crypto.randomUUID()
    const tokenId = crypto.randomUUID()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000)
    await client!`
      insert into admin_users (id, role) values (${userId}, 'admin')
    `
    await client!`
      insert into human_sessions (id, user_id, expires_at)
      values (${sessionId}, ${userId}, ${expiresAt.toISOString()}::timestamptz)
    `
    await client!`
      insert into api_tokens (id, created_by_principal, credential_owner_user_id, expires_at)
      values (${tokenId}, ${`human:${userId}`}, ${userId}, ${expiresAt.toISOString()}::timestamptz)
    `
    const handle = drizzle(client!, { schema })
    await expect(
      requireReplayableApiToken(
        tokenId,
        { type: "human", id: userId, sessionId },
        now,
        handle
      )
    ).resolves.toBeUndefined()

    // The token remains live when a single human session is revoked.
    await client!`
      update human_sessions set revoked_at = ${now.toISOString()}::timestamptz
      where id = ${sessionId}
    `
    const [created] = await client!`
      select revoked_at from api_tokens where id = ${tokenId}
    `
    expect(created?.revoked_at).toBeNull()

    await expect(
      requireReplayableApiToken(
        tokenId,
        { type: "human", id: userId, sessionId },
        now,
        handle
      )
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" })
  })

  it("rejects replay after the creator is demoted even if a legacy token stays live", async () => {
    const userId = crypto.randomUUID()
    const sessionId = crypto.randomUUID()
    const tokenId = crypto.randomUUID()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000)
    await client!`
      insert into admin_users (id, role) values (${userId}, 'admin')
    `
    await client!`
      insert into human_sessions (id, user_id, expires_at)
      values (${sessionId}, ${userId}, ${expiresAt.toISOString()}::timestamptz)
    `
    await client!`
      insert into api_tokens (id, created_by_principal, credential_owner_user_id, expires_at)
      values (${tokenId}, ${`human:${userId}`}, ${userId}, ${expiresAt.toISOString()}::timestamptz)
    `
    const handle = drizzle(client!, { schema })
    await client!`
      update admin_users set role = 'viewer' where id = ${userId}
    `

    await expect(
      requireReplayableApiToken(
        tokenId,
        { type: "human", id: userId, sessionId },
        now,
        handle
      )
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" })
  })

  it("rejects mint by a live machine token whose owner was demoted", async () => {
    const userId = crypto.randomUUID()
    const parentTokenId = crypto.randomUUID()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000)
    await client!`
      insert into admin_users (id, role) values (${userId}, 'viewer')
    `
    await client!`
      insert into api_tokens (id, created_by_principal, credential_owner_user_id, expires_at)
      values (${parentTokenId}, ${`human:${userId}`}, ${userId}, ${expiresAt.toISOString()}::timestamptz)
    `
    const handle = drizzle(client!, { schema })
    await expect(
      createApiToken(
        {
          name: "in-flight child",
          scopes: ["monitors:read"],
          expiresAt,
          principal: { type: "api_token", id: parentTokenId },
          credential: {
            raw: "pulse_live_child",
            prefix: "pulse_live_child",
            digest: Buffer.alloc(32, 9),
          },
        },
        now,
        handle
      )
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" })
  })
})
