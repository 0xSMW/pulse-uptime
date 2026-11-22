import { readFile } from "node:fs/promises"

import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { changeUserRole } from "@/lib/auth/invites"
import * as schema from "@/lib/db/schema"
import {
  revokeApiTokenSubtree,
  revokeUserMachineCredentials,
} from "./credential-revocation"
import {
  revokeAllMachineCredentials,
  revokeCliInstallationById,
} from "./device-authorization"

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
        password_changed_at timestamptz not null,
        role text not null default 'admin',
        updated_at timestamptz not null default now()
      );
      create table human_sessions (
        id uuid primary key,
        user_id uuid not null references admin_users(id),
        expires_at timestamptz not null default '2099-01-01 00:00:00+00',
        revoked_at timestamptz
      );
      create table api_tokens (
        id uuid primary key,
        principal_type text not null,
        principal_id text not null,
        created_by_principal text not null,
        scopes text[] not null default array['users:manage'],
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
      create table user_invites (
        id uuid primary key,
        token_digest bytea not null unique,
        role text not null default 'admin',
        created_by_principal text not null,
        expires_at timestamptz not null,
        accepted_at timestamptz,
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
    const inviteMigration = await readFile(
      new URL("../../drizzle/0033_revoke_rotated_invites.sql", import.meta.url),
      "utf8"
    )
    for (const statement of inviteMigration
      .split("--> statement-breakpoint")
      .map((part) => part.trim())
      .filter(Boolean)) {
      await client!.unsafe(statement)
    }
    // Preserve the older nullable owner shape on a delegated child. The
    // invite trigger must traverse the creator chain, not just owner IDs.
    await client!`
      update api_tokens set credential_owner_user_id = null
      where id = ${tokenIds[1]!}
    `

    const inviteCreators = [
      `human:${userId}`,
      `cli_session:${cliSessionId}`,
      `api_token:${tokenIds[1]}`,
      "human:ffffffff-ffff-4fff-8fff-ffffffffffff",
    ]
    for (const [index, creator] of inviteCreators.entries()) {
      await client!`
        insert into user_invites (id, token_digest, created_by_principal, expires_at)
        values (${crypto.randomUUID()}, ${Buffer.from([index + 1])}, ${creator}, ${new Date("2026-09-01T00:00:00Z")})
      `
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
    const invites = await client!`
      select created_by_principal, revoked_at from user_invites
      where created_by_principal = any(${inviteCreators})
    `
    expect(invites).toHaveLength(4)
    expect(
      invites
        .filter((invite) => invite.created_by_principal !== inviteCreators[3])
        .every((invite) => invite.revoked_at instanceof Date)
    ).toBe(true)
    expect(
      invites.find(
        (invite) => invite.created_by_principal === inviteCreators[3]
      )?.revoked_at
    ).toBeNull()
  })

  it("invalidates old invites when an old release changes the email", async () => {
    const userId = crypto.randomUUID()
    const installationId = crypto.randomUUID()
    const sessionId = crypto.randomUUID()
    const rootTokenId = crypto.randomUUID()
    const childTokenId = crypto.randomUUID()
    const grandchildTokenId = crypto.randomUUID()
    const oldEmail = "email-before@example.com"
    const newEmail = "email-after@example.com"
    const updatedAt = new Date("2026-11-14T20:00:00Z")
    await client!`
      insert into admin_users (id, email, password_digest, password_changed_at)
      values (${userId}, ${oldEmail}, 'digest', ${new Date("2026-08-12T00:00:00Z")})
    `
    await client!`
      insert into cli_installations (id, user_email, user_id)
      values (${installationId}, ${oldEmail}, null)
    `
    await client!`
      insert into cli_sessions (id, installation_id, user_email)
      values (${sessionId}, ${installationId}, ${oldEmail})
    `
    await client!`
      insert into api_tokens (
        id, principal_type, principal_id, created_by_principal,
        credential_owner_user_id
      ) values
        (${rootTokenId}, 'human', ${userId}, ${`human:${userId}`}, ${userId}),
        (${childTokenId}, 'api_token', ${rootTokenId}, ${`api_token:${rootTokenId}`}, null),
        (${grandchildTokenId}, 'api_token', ${childTokenId}, ${`api_token:${childTokenId}`}, null)
    `
    const inviteCreators = [
      `human:${userId}`,
      `cli_session:${sessionId}`,
      `api_token:${grandchildTokenId}`,
      `human:${crypto.randomUUID()}`,
    ]
    for (const [index, creator] of inviteCreators.entries()) {
      await client!`
        insert into user_invites (id, token_digest, created_by_principal, expires_at)
        values (${crypto.randomUUID()}, ${Buffer.from([index + 10])}, ${creator}, ${new Date("2026-12-01T00:00:00Z")})
      `
    }

    await client!`
      update admin_users
      set email = ${newEmail}, updated_at = ${updatedAt}
      where id = ${userId}
    `

    const invites = await client!`
      select created_by_principal, revoked_at from user_invites
      where created_by_principal = any(${inviteCreators})
    `
    expect(invites).toHaveLength(4)
    expect(
      invites
        .filter((invite) => invite.created_by_principal !== inviteCreators[3])
        .every((invite) => invite.revoked_at instanceof Date)
    ).toBe(true)
    expect(
      invites.find(
        (invite) => invite.created_by_principal === inviteCreators[3]
      )?.revoked_at
    ).toBeNull()
    const claimed = await client!`
      update user_invites
      set accepted_at = CURRENT_TIMESTAMP
      where created_by_principal = ${inviteCreators[2]!}
        and accepted_at is null
        and revoked_at is null
        and expires_at > CURRENT_TIMESTAMP
      returning id
    `
    expect(claimed).toHaveLength(0)
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
    const ownerInviteId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
    const tokenInviteId = "ffffffff-ffff-4fff-8fff-ffffffffffff"
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
    await client!`
      insert into user_invites (id, token_digest, created_by_principal, expires_at)
      values
        (${ownerInviteId}, decode('aa', 'hex'), ${`human:${userId}`}, ${new Date("2026-08-20T07:00:00.000Z")}),
        (${tokenInviteId}, decode('bb', 'hex'), ${`api_token:${tokenId}`}, ${new Date("2026-08-20T07:00:00.000Z")})
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
    const inviteRows = await client!`
      select id, revoked_at from user_invites
      where id in (${ownerInviteId}, ${tokenInviteId})
    `
    expect(inviteRows).toHaveLength(2)
    for (const invite of inviteRows) {
      expect(new Date(invite.revoked_at as string)).toEqual(now)
    }

    // The same pending, unrevoked, unexpired predicate guards the atomic
    // claim in acceptUserInvite. A stashed admin link cannot claim this row.
    const claimed = await client!`
      update user_invites
      set accepted_at = ${now.toISOString()}::timestamptz
      where id = ${tokenInviteId}
        and accepted_at is null
        and revoked_at is null
        and expires_at > ${now.toISOString()}::timestamptz
      returning id
    `
    expect(claimed).toHaveLength(0)
  })

  it("invalidates an admin invite when its API-token creator is revoked", async () => {
    const userId = "10101010-1010-4010-8010-101010101010"
    const tokenId = "20202020-2020-4020-8020-202020202020"
    const inviteId = "30303030-3030-4030-8030-303030303030"
    const now = new Date("2026-08-14T00:00:00.000Z")
    await client!`
      insert into admin_users (id, email, password_digest, password_changed_at)
      values (${userId}, 'token-owner@example.com', 'digest', ${now.toISOString()}::timestamptz)
    `
    await client!`
      insert into api_tokens (id, principal_type, principal_id, created_by_principal, credential_owner_user_id)
      values (${tokenId}, 'human', ${userId}, ${`human:${userId}`}, ${userId})
    `
    await client!`
      insert into user_invites (id, token_digest, created_by_principal, expires_at)
      values (${inviteId}, decode('cc', 'hex'), ${`api_token:${tokenId}`}, ${"2026-08-21T00:00:00.000Z"}::timestamptz)
    `
    const [credentialAndInvite] = await client!`
      select token.scopes, invite.role
      from api_tokens as token
      inner join user_invites as invite
        on invite.created_by_principal = 'api_token:' || token.id::text
      where invite.id = ${inviteId}
    `
    expect(credentialAndInvite).toMatchObject({
      scopes: ["users:manage"],
      role: "admin",
    })

    const handle = drizzle(client!, { schema })
    await handle.transaction((tx) => revokeApiTokenSubtree(tx, tokenId, now))

    const [invite] = await client!`
      select revoked_at from user_invites where id = ${inviteId}
    `
    expect(new Date(invite?.revoked_at as string)).toEqual(now)
    const claimed = await client!`
      update user_invites
      set accepted_at = ${now.toISOString()}::timestamptz
      where id = ${inviteId}
        and accepted_at is null
        and revoked_at is null
        and expires_at > ${now.toISOString()}::timestamptz
      returning id
    `
    expect(claimed).toHaveLength(0)
  })

  it("invalidates an admin invite when its CLI installation is revoked", async () => {
    const userId = "40404040-4040-4040-8040-404040404040"
    const installationId = "50505050-5050-4050-8050-505050505050"
    const sessionId = "60606060-6060-4060-8060-606060606060"
    const inviteId = "70707070-7070-4070-8070-707070707070"
    const now = new Date("2026-08-14T01:00:00.000Z")
    await client!`
      insert into admin_users (id, email, password_digest, password_changed_at)
      values (${userId}, 'cli-owner@example.com', 'digest', ${now.toISOString()}::timestamptz)
    `
    await client!`
      insert into cli_installations (id, user_email)
      values (${installationId}, 'cli-owner@example.com')
    `
    await client!`
      insert into cli_sessions (id, installation_id, user_email)
      values (${sessionId}, ${installationId}, 'cli-owner@example.com')
    `
    await client!`
      insert into user_invites (id, token_digest, created_by_principal, expires_at)
      values (${inviteId}, decode('dd', 'hex'), ${`cli_session:${sessionId}`}, ${"2026-08-21T00:00:00.000Z"}::timestamptz)
    `

    const handle = drizzle(client!, { schema })
    await revokeCliInstallationById(installationId, now, handle)

    const [invite] = await client!`
      select revoked_at from user_invites where id = ${inviteId}
    `
    expect(new Date(invite?.revoked_at as string)).toEqual(now)
  })

  it("invalidates machine-created invites during emergency credential revocation", async () => {
    const userId = "80808080-8080-4080-8080-808080808080"
    const tokenId = "90909090-9090-4090-8090-909090909090"
    const machineInviteId = "a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0"
    const humanInviteId = "b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0"
    const now = new Date("2026-08-14T02:00:00.000Z")
    await client!`
      insert into admin_users (id, email, password_digest, password_changed_at)
      values (${userId}, 'recovery@example.com', 'digest', ${now.toISOString()}::timestamptz)
    `
    await client!`
      insert into api_tokens (id, principal_type, principal_id, created_by_principal, credential_owner_user_id)
      values (${tokenId}, 'human', ${userId}, ${`human:${userId}`}, ${userId})
    `
    await client!`
      insert into user_invites (id, token_digest, created_by_principal, expires_at)
      values
        (${machineInviteId}, decode('ee', 'hex'), ${`api_token:${tokenId}`}, ${"2026-08-21T00:00:00.000Z"}::timestamptz),
        (${humanInviteId}, decode('ff', 'hex'), ${`human:${userId}`}, ${"2026-08-21T00:00:00.000Z"}::timestamptz)
    `

    const handle = drizzle(client!, { schema })
    await revokeAllMachineCredentials(now, handle)

    const invites = await client!`
      select id, revoked_at from user_invites
      where id in (${machineInviteId}, ${humanInviteId})
    `
    expect(
      new Date(
        invites.find((invite) => invite.id === machineInviteId)!
          .revoked_at as string
      )
    ).toEqual(now)
    expect(
      invites.find((invite) => invite.id === humanInviteId)?.revoked_at
    ).toBeNull()
  })

  it("revokes deep token descendants and their admin invite on owner demotion", async () => {
    const ownerId = "c0c0c0c0-c0c0-40c0-80c0-c0c0c0c0c0c0"
    const otherAdminId = "d0d0d0d0-d0d0-40d0-80d0-d0d0d0d0d0d0"
    const sessionId = "e0e0e0e0-e0e0-40e0-80e0-e0e0e0e0e0e0"
    const rootTokenId = "f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0"
    const childTokenId = "01010101-0101-4101-8101-010101010101"
    const grandchildTokenId = "02020202-0202-4202-8202-020202020202"
    const inviteId = "03030303-0303-4303-8303-030303030303"
    const now = new Date("2026-08-14T03:00:00.000Z")
    await client!`
      insert into admin_users (id, email, password_digest, password_changed_at)
      values
        (${ownerId}, 'demoted@example.com', 'digest', ${now.toISOString()}::timestamptz),
        (${otherAdminId}, 'remaining@example.com', 'digest', ${now.toISOString()}::timestamptz)
    `
    await client!`
      insert into human_sessions (id, user_id)
      values (${sessionId}, ${ownerId})
    `
    await client!`
      insert into api_tokens (id, principal_type, principal_id, created_by_principal, credential_owner_user_id)
      values
        (${rootTokenId}, 'human', ${ownerId}, ${`human:${ownerId}`}, ${ownerId}),
        (${childTokenId}, 'api_token', ${rootTokenId}, ${`api_token:${rootTokenId}`}, null),
        (${grandchildTokenId}, 'api_token', ${childTokenId}, ${`api_token:${childTokenId}`}, null)
    `
    await client!`
      insert into user_invites (id, token_digest, created_by_principal, expires_at)
      values (${inviteId}, decode('ab', 'hex'), ${`api_token:${grandchildTokenId}`}, ${"2026-08-21T00:00:00.000Z"}::timestamptz)
    `

    const handle = drizzle(client!, { schema })
    await changeUserRole(
      {
        userId: ownerId,
        role: "viewer",
        actor: {
          type: "human",
          id: ownerId,
          sessionId,
          email: "demoted@example.com",
          role: "admin",
          scopes: ["users:manage"],
        },
      },
      now,
      handle
    )

    const tokens = await client!`
      select id, revoked_at from api_tokens
      where id in (${rootTokenId}, ${childTokenId}, ${grandchildTokenId})
    `
    expect(tokens).toHaveLength(3)
    for (const token of tokens) {
      expect(new Date(token.revoked_at as string)).toEqual(now)
    }
    const [invite] = await client!`
      select revoked_at from user_invites where id = ${inviteId}
    `
    expect(new Date(invite?.revoked_at as string)).toEqual(now)
  })
})
