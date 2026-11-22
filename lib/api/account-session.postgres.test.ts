import postgres from "postgres"
import { afterAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  changeAccountEmail,
  revokeAccountSession,
  revokeOtherAccountSessions,
} from "./account"

const databaseUrl = process.env.TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip
const client = databaseUrl ? postgres(databaseUrl, { prepare: false }) : null

suite("account writes after session revocation", () => {
  afterAll(async () => {
    await client?.end()
  })

  it("does not revoke other sessions when the acting session was revoked after route authorization", async () => {
    const userId = crypto.randomUUID()
    const currentSessionId = crypto.randomUUID()
    const otherSessionId = crypto.randomUUID()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000)
    await client!`
      insert into admin_users (
        id, email, password_digest, role, created_at, updated_at, password_changed_at
      ) values (
        ${userId}, ${`account-race-${userId}@example.com`}, 'digest', 'viewer',
        ${now.toISOString()}::timestamptz,
        ${now.toISOString()}::timestamptz,
        ${now.toISOString()}::timestamptz
      )
    `
    try {
      await client!`
        insert into human_sessions (
          id, user_id, token_digest, created_at, expires_at
        ) values
          (${currentSessionId}, ${userId}, ${Buffer.from(crypto.randomUUID())},
            ${now.toISOString()}::timestamptz, ${expiresAt.toISOString()}::timestamptz),
          (${otherSessionId}, ${userId}, ${Buffer.from(crypto.randomUUID())},
            ${now.toISOString()}::timestamptz, ${expiresAt.toISOString()}::timestamptz)
      `
      await client!`
        update human_sessions
        set revoked_at = ${now.toISOString()}::timestamptz
        where id = ${currentSessionId}
      `

      await expect(
        revokeOtherAccountSessions({ userId, currentSessionId })
      ).rejects.toMatchObject({ code: "SESSION_REVOKED" })
      const [other] = await client!`
        select revoked_at from human_sessions where id = ${otherSessionId}
      `
      expect(other?.revoked_at).toBeNull()
    } finally {
      await client!`delete from human_sessions where user_id = ${userId}`
      await client!`delete from admin_users where id = ${userId}`
    }
  })

  it("contains only credentials issued by explicitly revoked sessions", async () => {
    const userId = crypto.randomUUID()
    const currentSessionId = crypto.randomUUID()
    const stolenSessionId = crypto.randomUUID()
    const otherSessionId = crypto.randomUUID()
    const stolenTokenId = crypto.randomUUID()
    const descendantTokenId = crypto.randomUUID()
    const otherTokenId = crypto.randomUUID()
    const installationId = crypto.randomUUID()
    const cliSessionId = crypto.randomUUID()
    const cliTokenId = crypto.randomUUID()
    const directInviteId = crypto.randomUUID()
    const tokenInviteId = crypto.randomUUID()
    const cliInviteId = crypto.randomUUID()
    const otherInviteId = crypto.randomUUID()
    const email = `session-lineage-${userId}@example.com`
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000)
    const stamp = now.toISOString()
    const expiry = expiresAt.toISOString()
    await client!`
      insert into admin_users (
        id, email, password_digest, role, created_at, updated_at, password_changed_at
      ) values (
        ${userId}, ${email}, 'digest', 'admin',
        ${stamp}::timestamptz, ${stamp}::timestamptz, ${stamp}::timestamptz
      )
    `
    try {
      for (const sessionId of [
        currentSessionId,
        stolenSessionId,
        otherSessionId,
      ]) {
        await client!`
          insert into human_sessions (id, user_id, token_digest, created_at, expires_at)
          values (${sessionId}, ${userId}, ${Buffer.from(crypto.randomUUID())},
            ${stamp}::timestamptz, ${expiry}::timestamptz)
        `
      }
      const addToken = async (
        id: string,
        principalType: string,
        principalId: string,
        creator: string,
        issuerSessionId: string | null
      ) => {
        await client!`
          insert into api_tokens (
            id, name, token_prefix, token_digest, principal_type,
            principal_id, scopes, created_at, created_by_principal,
            issued_by_human_session_id, credential_owner_user_id, expires_at
          ) values (
            ${id}, 'team token', 'pulse_live', ${Buffer.from(crypto.randomUUID())},
            ${principalType}, ${principalId}, array['users:manage']::text[],
            ${stamp}::timestamptz, ${creator}, ${issuerSessionId}, ${userId},
            ${expiry}::timestamptz
          )
        `
      }
      await addToken(
        stolenTokenId,
        "human",
        userId,
        `human:${userId}`,
        stolenSessionId
      )
      await addToken(
        descendantTokenId,
        "api_token",
        stolenTokenId,
        `api_token:${stolenTokenId}`,
        null
      )
      await addToken(
        otherTokenId,
        "human",
        userId,
        `human:${userId}`,
        otherSessionId
      )
      await client!`
        insert into cli_installations (
          id, installation_key, user_email, user_id,
          authorized_by_human_session_id, display_name, platform,
          architecture, client_version, created_at, linked_at
        ) values (
          ${installationId}, ${crypto.randomUUID()}, ${email}, ${userId},
          ${stolenSessionId}, 'laptop', 'test', 'test', '1.0',
          ${stamp}::timestamptz, ${stamp}::timestamptz
        )
      `
      await client!`
        insert into cli_sessions (
          id, installation_id, token_prefix, token_digest, user_email,
          scopes, created_at, expires_at
        ) values (
          ${cliSessionId}, ${installationId}, 'pulse_cli',
          ${Buffer.from(crypto.randomUUID())}, ${email},
          array['users:manage']::text[],
          ${stamp}::timestamptz, ${expiry}::timestamptz
        )
      `
      await addToken(
        cliTokenId,
        "cli_session",
        cliSessionId,
        `cli_session:${cliSessionId}`,
        null
      )
      const addInvite = async (
        id: string,
        creator: string,
        issuerSessionId: string | null
      ) => {
        await client!`
          insert into user_invites (
            id, token_digest, role, created_by_principal,
            issued_by_human_session_id, created_at, expires_at
          ) values (
            ${id}, ${Buffer.from(crypto.randomUUID())}, 'admin', ${creator},
            ${issuerSessionId}, ${stamp}::timestamptz, ${expiry}::timestamptz
          )
        `
      }
      await addInvite(directInviteId, `human:${userId}`, stolenSessionId)
      await addInvite(tokenInviteId, `api_token:${descendantTokenId}`, null)
      await addInvite(cliInviteId, `api_token:${cliTokenId}`, null)
      await addInvite(otherInviteId, `human:${userId}`, otherSessionId)

      // A normal logout can mark the stolen session revoked without touching
      // credentials it issued. Explicit account revocation still contains it.
      await client!`
        update human_sessions
        set revoked_at = ${stamp}::timestamptz
        where id = ${stolenSessionId}
      `

      await revokeAccountSession({
        userId,
        currentSessionId,
        sessionId: stolenSessionId,
      })

      const tokens = await client!`
        select id, revoked_at from api_tokens
        where id in (${stolenTokenId}, ${descendantTokenId}, ${cliTokenId}, ${otherTokenId})
      `
      for (const token of tokens) {
        expect(token.revoked_at instanceof Date).toBe(token.id !== otherTokenId)
      }
      const invites = await client!`
        select id, revoked_at from user_invites
        where id in (${directInviteId}, ${tokenInviteId}, ${cliInviteId}, ${otherInviteId})
      `
      for (const invite of invites) {
        expect(invite.revoked_at instanceof Date).toBe(
          invite.id !== otherInviteId
        )
      }
      const [installation] = await client!`
        select revoked_at from cli_installations where id = ${installationId}
      `
      const [cliSession] = await client!`
        select revoked_at from cli_sessions where id = ${cliSessionId}
      `
      expect(installation?.revoked_at).toBeInstanceOf(Date)
      expect(cliSession?.revoked_at).toBeInstanceOf(Date)

      await client!`
        update human_sessions
        set revoked_at = ${stamp}::timestamptz
        where id = ${otherSessionId}
      `
      await expect(
        revokeOtherAccountSessions({ userId, currentSessionId })
      ).resolves.toEqual({ revokedCount: 0 })
      const [otherToken] = await client!`
        select revoked_at from api_tokens where id = ${otherTokenId}
      `
      const [otherInvite] = await client!`
        select revoked_at from user_invites where id = ${otherInviteId}
      `
      expect(otherToken?.revoked_at).toBeInstanceOf(Date)
      expect(otherInvite?.revoked_at).toBeInstanceOf(Date)
      const [current] = await client!`
        select revoked_at from human_sessions where id = ${currentSessionId}
      `
      expect(current?.revoked_at).toBeNull()
    } finally {
      await client!`delete from user_invites where created_by_principal in (${`human:${userId}`}, ${`api_token:${descendantTokenId}`}, ${`api_token:${cliTokenId}`})`
      await client!`delete from api_tokens where credential_owner_user_id = ${userId}`
      await client!`delete from cli_sessions where installation_id = ${installationId}`
      await client!`delete from cli_installations where id = ${installationId}`
      await client!`delete from human_sessions where user_id = ${userId}`
      await client!`delete from admin_users where id = ${userId}`
    }
  })

  it("contains credentials from other sessions during email change, including an earlier logout", async () => {
    const userId = crypto.randomUUID()
    const currentSessionId = crypto.randomUUID()
    const otherSessionId = crypto.randomUUID()
    const currentTokenId = crypto.randomUUID()
    const otherTokenId = crypto.randomUUID()
    const oldEmail = `email-change-${userId}@example.com`
    const newEmail = `renamed-${userId}@example.com`
    const now = new Date()
    const stamp = now.toISOString()
    const expiry = new Date(now.getTime() + 24 * 60 * 60_000).toISOString()
    await client!`
      insert into admin_users (id, email, password_digest, role, created_at, updated_at, password_changed_at)
      values (${userId}, ${oldEmail}, 'digest', 'admin', ${stamp}::timestamptz, ${stamp}::timestamptz, ${stamp}::timestamptz)
    `
    try {
      for (const sessionId of [currentSessionId, otherSessionId]) {
        await client!`
          insert into human_sessions (id, user_id, token_digest, created_at, expires_at)
          values (${sessionId}, ${userId}, ${Buffer.from(crypto.randomUUID())}, ${stamp}::timestamptz, ${expiry}::timestamptz)
        `
        const tokenId =
          sessionId === currentSessionId ? currentTokenId : otherTokenId
        await client!`
          insert into api_tokens (
            id, name, token_prefix, token_digest, principal_type, principal_id, scopes,
            created_at, created_by_principal, issued_by_human_session_id,
            credential_owner_user_id, expires_at
          ) values (
            ${tokenId}, 'team token', 'pulse_live', ${Buffer.from(crypto.randomUUID())},
            'human', ${userId}, array['users:manage']::text[], ${stamp}::timestamptz,
            ${`human:${userId}`}, ${sessionId}, ${userId}, ${expiry}::timestamptz
          )
        `
      }
      await client!`
        update human_sessions set revoked_at = ${stamp}::timestamptz
        where id = ${otherSessionId}
      `
      await changeAccountEmail(
        {
          userId,
          currentSessionId,
          ip: "203.0.113.7",
          currentPassword: "correct password",
          email: newEmail,
          emailConfirm: newEmail,
        },
        {
          verify: async () => true,
          enforceLimit: async () => ({
            allowed: true,
            remaining: 4,
            retryAfterSeconds: 1,
          }),
          digestKey: (value) => Buffer.from(value),
          now: () => now,
        }
      )
      const tokens = await client!`
        select id, revoked_at from api_tokens where id in (${currentTokenId}, ${otherTokenId})
      `
      for (const token of tokens) {
        expect(token.revoked_at instanceof Date).toBe(token.id === otherTokenId)
      }
      const [currentSession] = await client!`
        select revoked_at from human_sessions where id = ${currentSessionId}
      `
      expect(currentSession?.revoked_at).toBeNull()
    } finally {
      await client!`delete from api_tokens where credential_owner_user_id = ${userId}`
      await client!`delete from human_sessions where user_id = ${userId}`
      await client!`delete from admin_users where id = ${userId}`
    }
  })
})
