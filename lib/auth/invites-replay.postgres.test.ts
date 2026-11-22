import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import * as schema from "@/lib/db/schema"
import { requireReplayableUserInvite } from "./invites"

const databaseUrl = process.env.TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip
const schemaName = `invite_replay_${crypto.randomUUID().replaceAll("-", "")}`
const client = databaseUrl
  ? postgres(databaseUrl, {
      max: 2,
      prepare: false,
      connection: { search_path: schemaName },
    })
  : null

suite("invite replay PostgreSQL authority", () => {
  beforeAll(async () => {
    await client!.unsafe(`create schema "${schemaName}"`)
    await client!.unsafe(`
      create table admin_users (id uuid primary key, role text not null);
      create table human_sessions (
        id uuid primary key, user_id uuid not null references admin_users(id),
        expires_at timestamptz not null, revoked_at timestamptz
      );
      create table user_invites (
        id uuid primary key, token_digest bytea not null,
        created_by_principal text not null,
        expires_at timestamptz not null,
        accepted_at timestamptz, revoked_at timestamptz
      );
    `)
  })

  afterAll(async () => {
    if (client) {
      await client.unsafe(`drop schema if exists "${schemaName}" cascade`)
      await client.end()
    }
  })

  it("denies a live invite replay after exact session revocation or invite revocation", async () => {
    const userId = crypto.randomUUID()
    const sessionId = crypto.randomUUID()
    const inviteId = crypto.randomUUID()
    const digest = Buffer.alloc(32, 7)
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
      insert into user_invites (id, token_digest, created_by_principal, expires_at)
      values (${inviteId}, ${digest}, ${`human:${userId}`}, ${expiresAt.toISOString()}::timestamptz)
    `
    const handle = drizzle(client!, { schema })
    const actor = {
      type: "human" as const,
      id: userId,
      sessionId,
      email: "admin@example.com",
      role: "admin" as const,
      scopes: ["users:manage" as const],
    }
    await expect(
      requireReplayableUserInvite(inviteId, digest, actor, now, handle)
    ).resolves.toBeUndefined()

    await client!`
      update human_sessions
      set revoked_at = ${now.toISOString()}::timestamptz
      where id = ${sessionId}
    `
    const [pending] = await client!`
      select revoked_at from user_invites where id = ${inviteId}
    `
    expect(pending?.revoked_at).toBeNull()
    await expect(
      requireReplayableUserInvite(inviteId, digest, actor, now, handle)
    ).rejects.toMatchObject({ code: "ACTOR_DENIED" })

    await client!`
      update human_sessions set revoked_at = null where id = ${sessionId}
    `
    await client!`
      update user_invites
      set revoked_at = ${now.toISOString()}::timestamptz
      where id = ${inviteId}
    `
    await expect(
      requireReplayableUserInvite(inviteId, digest, actor, now, handle)
    ).rejects.toMatchObject({ code: "INVITE_INVALID" })
  })
})
