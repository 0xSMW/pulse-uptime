import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import * as schema from "@/lib/db/schema"
import { hasLiveScope } from "./live-authority"
import type { Principal } from "./principal"

const databaseUrl = process.env.TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip
const schemaName = `live_authority_${crypto.randomUUID().replaceAll("-", "")}`
const client = databaseUrl
  ? postgres(databaseUrl, {
      max: 3,
      prepare: false,
      connection: { search_path: schemaName },
    })
  : null

const userId = "11111111-1111-4111-8111-111111111111"
const humanSessionId = "22222222-2222-4222-8222-222222222222"
const tokenId = "33333333-3333-4333-8333-333333333333"
const installationId = "44444444-4444-4444-8444-444444444444"
const cliSessionId = "55555555-5555-4555-8555-555555555555"
const future = new Date("2099-01-01T00:00:00Z")

const human: Principal = {
  type: "human",
  id: userId,
  sessionId: humanSessionId,
  email: "owner@example.com",
  role: "admin",
  scopes: ["monitors:write"],
}
const apiToken: Principal = {
  type: "api_token",
  id: tokenId,
  name: "operator",
  scopes: ["monitors:write"],
  expiresAt: future,
}
const cli: Principal = {
  type: "cli_session",
  id: cliSessionId,
  email: "owner@example.com",
  scopes: ["monitors:write"],
  expiresAt: future,
  installation: {
    id: installationId,
    displayName: "CLI",
    platform: "test",
    architecture: "test",
    clientVersion: "1.0",
    linkedAt: new Date("2026-01-01T00:00:00Z"),
  },
}

suite("live mutation authority in PostgreSQL", () => {
  beforeAll(async () => {
    await client!.unsafe(`create schema "${schemaName}"`)
    await client!.unsafe(`
      create table admin_users (
        id uuid primary key, role text not null, credential_epoch integer not null
      );
      create table human_sessions (
        id uuid primary key, user_id uuid not null references admin_users(id),
        expires_at timestamptz not null, revoked_at timestamptz
      );
      create table api_tokens (
        id uuid primary key, credential_owner_user_id uuid references admin_users(id),
        scopes text[] not null, credential_epoch integer not null,
        expires_at timestamptz not null, revoked_at timestamptz
      );
      create table cli_installations (
        id uuid primary key, user_id uuid references admin_users(id),
        credential_epoch integer not null, revoked_at timestamptz
      );
      create table cli_sessions (
        id uuid primary key, installation_id uuid not null references cli_installations(id),
        scopes text[] not null, scope_profile text,
        expires_at timestamptz not null, revoked_at timestamptz
      );
    `)
    await client!`
      insert into admin_users (id, role, credential_epoch)
      values (${userId}, 'admin', 0)
    `
    await client!`
      insert into human_sessions (id, user_id, expires_at)
      values (${humanSessionId}, ${userId}, ${future})
    `
    await client!`
      insert into api_tokens (id, credential_owner_user_id, scopes, credential_epoch, expires_at)
      values (${tokenId}, ${userId}, ${["monitors:write"]}, 0, ${future})
    `
    await client!`
      insert into cli_installations (id, user_id, credential_epoch)
      values (${installationId}, ${userId}, 0)
    `
    await client!`
      insert into cli_sessions (id, installation_id, scopes, scope_profile, expires_at)
      values (${cliSessionId}, ${installationId}, ${["monitors:write"]}, 'administrator', ${future})
    `
  })

  afterAll(async () => {
    if (client) {
      await client.unsafe(`drop schema if exists "${schemaName}" cascade`)
      await client.end()
    }
  })

  it("rejects a cached admin human principal after demotion", async () => {
    await client!`update admin_users set role = 'viewer' where id = ${userId}`
    const handle = drizzle(client!, { schema })
    expect(
      await handle.transaction((tx) =>
        hasLiveScope(tx, human, "monitors:write")
      )
    ).toBe(false)
    await client!`update admin_users set role = 'admin' where id = ${userId}`
  })

  it("rejects revoked API and CLI credentials after route authorization", async () => {
    const now = new Date()
    await client!`update api_tokens set revoked_at = ${now.toISOString()}::timestamptz where id = ${tokenId}`
    await client!`update cli_installations set revoked_at = ${now.toISOString()}::timestamptz where id = ${installationId}`
    const handle = drizzle(client!, { schema })
    expect(
      await handle.transaction((tx) =>
        hasLiveScope(tx, apiToken, "monitors:write")
      )
    ).toBe(false)
    expect(
      await handle.transaction((tx) => hasLiveScope(tx, cli, "monitors:write"))
    ).toBe(false)
    await client!`update api_tokens set revoked_at = null where id = ${tokenId}`
    await client!`update cli_installations set revoked_at = null where id = ${installationId}`
  })

  it("rejects expired human, API, and CLI credentials after route authorization", async () => {
    const past = new Date("2000-01-01T00:00:00Z")
    await client!`update human_sessions set expires_at = ${past.toISOString()}::timestamptz where id = ${humanSessionId}`
    await client!`update api_tokens set expires_at = ${past.toISOString()}::timestamptz where id = ${tokenId}`
    await client!`update cli_sessions set expires_at = ${past.toISOString()}::timestamptz where id = ${cliSessionId}`
    try {
      const handle = drizzle(client!, { schema })
      for (const principal of [human, apiToken, cli]) {
        expect(
          await handle.transaction((tx) =>
            hasLiveScope(tx, principal, "monitors:write")
          )
        ).toBe(false)
      }
    } finally {
      await client!`update human_sessions set expires_at = ${future.toISOString()}::timestamptz where id = ${humanSessionId}`
      await client!`update api_tokens set expires_at = ${future.toISOString()}::timestamptz where id = ${tokenId}`
      await client!`update cli_sessions set expires_at = ${future.toISOString()}::timestamptz where id = ${cliSessionId}`
    }
  })

  it("uses the live CLI profile and rejects a changed credential epoch", async () => {
    const handle = drizzle(client!, { schema })
    expect(
      await handle.transaction((tx) => hasLiveScope(tx, cli, "monitors:write"))
    ).toBe(true)
    await client!`
      update admin_users set credential_epoch = credential_epoch + 1
      where id = ${userId}
    `
    expect(
      await handle.transaction((tx) =>
        hasLiveScope(tx, apiToken, "monitors:write")
      )
    ).toBe(false)
    expect(
      await handle.transaction((tx) => hasLiveScope(tx, cli, "monitors:write"))
    ).toBe(false)
    await client!`
      update admin_users set credential_epoch = credential_epoch - 1
      where id = ${userId}
    `
  })

  it("holds authority until a human mutation commits before demotion", async () => {
    const handle = drizzle(client!, { schema })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const acquired = new Promise<void>((resolve) => {
      entered = resolve
    })
    const mutation = handle.transaction(async (tx) => {
      expect(await hasLiveScope(tx, human, "monitors:write")).toBe(true)
      entered()
      await held
    })
    await acquired
    let demoted = false
    const demotion = client!`
      update admin_users set role = 'viewer' where id = ${userId}
    `.then(() => {
      demoted = true
    })
    await new Promise((resolve) => setTimeout(resolve, 75))
    expect(demoted).toBe(false)
    release()
    await mutation
    await demotion
    expect(demoted).toBe(true)
    await client!`update admin_users set role = 'admin' where id = ${userId}`
  })

  it("holds machine authority until the mutation commits before token revocation", async () => {
    const handle = drizzle(client!, { schema })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const acquired = new Promise<void>((resolve) => {
      entered = resolve
    })
    const mutation = handle.transaction(async (tx) => {
      expect(await hasLiveScope(tx, apiToken, "monitors:write")).toBe(true)
      entered()
      await held
    })
    await acquired
    let revoked = false
    const revocation = client!`
      update api_tokens set revoked_at = now() where id = ${tokenId}
    `.then(() => {
      revoked = true
    })
    await new Promise((resolve) => setTimeout(resolve, 75))
    expect(revoked).toBe(false)
    release()
    await mutation
    await revocation
    expect(revoked).toBe(true)
  })
})
