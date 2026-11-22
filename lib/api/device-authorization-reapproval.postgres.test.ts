import postgres from "postgres"
import { afterAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { revokeAccountSession } from "./account"
import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
} from "./device-authorization"

const databaseUrl = process.env.TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip
const client = databaseUrl ? postgres(databaseUrl, { prepare: false }) : null

suite("CLI installation reapproval PostgreSQL containment", () => {
  afterAll(async () => {
    await client?.end()
  })

  it.each(["revoked", "demoted"] as const)(
    "does not deny a pending device request after the administrator is %s",
    async (state) => {
      const userId = crypto.randomUUID()
      const sessionId = crypto.randomUUID()
      const authorizationId = crypto.randomUUID()
      const email = `cli-denial-${userId}@example.com`
      const now = new Date()
      const stamp = now.toISOString()
      const expiry = new Date(now.getTime() + 24 * 60 * 60_000).toISOString()
      const userCode = crypto.randomUUID().slice(0, 8).toUpperCase()
      await client!`
        insert into admin_users (id, email, password_digest, role, created_at, updated_at, password_changed_at)
        values (${userId}, ${email}, 'digest', 'admin', ${stamp}::timestamptz, ${stamp}::timestamptz, ${stamp}::timestamptz)
      `
      try {
        await client!`
          insert into human_sessions (id, user_id, token_digest, created_at, expires_at)
          values (${sessionId}, ${userId}, ${Buffer.from(crypto.randomUUID())}, ${stamp}::timestamptz, ${expiry}::timestamptz)
        `
        await client!`
          insert into device_authorizations (
            id, device_code_digest, user_code, scope_profile, client_name,
            installation_key, installation_name, platform, architecture,
            client_version, state, created_at, expires_at, polling_interval_seconds
          ) values (
            ${authorizationId}, ${Buffer.from(crypto.randomUUID())}, ${userCode},
            'administrator', 'pulsectl', ${crypto.randomUUID()}, 'laptop', 'test', 'test',
            '1.0', 'pending', ${stamp}::timestamptz, ${expiry}::timestamptz, 5
          )
        `
        if (state === "revoked") {
          await client!`update human_sessions set revoked_at = ${stamp}::timestamptz where id = ${sessionId}`
        } else {
          await client!`update admin_users set role = 'viewer' where id = ${userId}`
        }

        await expect(
          denyDeviceAuthorization(
            userCode,
            { id: userId, sessionId, email },
            now
          )
        ).rejects.toMatchObject({ code: "access_denied" })
        const [pending] = await client!`
          select state, denied_at from device_authorizations where id = ${authorizationId}
        `
        expect(pending).toMatchObject({ state: "pending", denied_at: null })
      } finally {
        await client!`delete from device_authorizations where id = ${authorizationId}`
        await client!`delete from human_sessions where user_id = ${userId}`
        await client!`delete from admin_users where id = ${userId}`
      }
    }
  )

  it("retires old CLI credentials and invites before changing the authorizing human session", async () => {
    const userId = crypto.randomUUID()
    const sessionA = crypto.randomUUID()
    const sessionB = crypto.randomUUID()
    const installationId = crypto.randomUUID()
    const oldCliSessionId = crypto.randomUUID()
    const newCliSessionId = crypto.randomUUID()
    const tokenId = crypto.randomUUID()
    const inviteId = crypto.randomUUID()
    const authorizationId = crypto.randomUUID()
    const installationKey = crypto.randomUUID()
    const email = `cli-reapproval-${userId}@example.com`
    const now = new Date()
    const stamp = now.toISOString()
    const expiry = new Date(now.getTime() + 24 * 60 * 60_000).toISOString()
    await client!`
      insert into admin_users (id, email, password_digest, role, created_at, updated_at, password_changed_at)
      values (${userId}, ${email}, 'digest', 'admin', ${stamp}::timestamptz, ${stamp}::timestamptz, ${stamp}::timestamptz)
    `
    try {
      for (const sessionId of [sessionA, sessionB]) {
        await client!`
          insert into human_sessions (id, user_id, token_digest, created_at, expires_at)
          values (${sessionId}, ${userId}, ${Buffer.from(crypto.randomUUID())}, ${stamp}::timestamptz, ${expiry}::timestamptz)
        `
      }
      await client!`
        insert into cli_installations (
          id, installation_key, user_email, user_id, authorized_by_human_session_id,
          display_name, platform, architecture, client_version, created_at, linked_at
        ) values (
          ${installationId}, ${installationKey}, ${email}, ${userId}, ${sessionA},
          'laptop', 'test', 'test', '1.0', ${stamp}::timestamptz, ${stamp}::timestamptz
        )
      `
      await client!`
        insert into cli_sessions (
          id, installation_id, token_prefix, token_digest, user_email, scopes, created_at, expires_at
        ) values (
          ${oldCliSessionId}, ${installationId}, 'pulse_cli', ${Buffer.from(crypto.randomUUID())},
          ${email}, array['users:manage']::text[], ${stamp}::timestamptz, ${expiry}::timestamptz
        )
      `
      await client!`
        insert into api_tokens (
          id, name, token_prefix, token_digest, principal_type, principal_id, scopes,
          created_at, created_by_principal, credential_owner_user_id, expires_at
        ) values (
          ${tokenId}, 'old CLI token', 'pulse_live', ${Buffer.from(crypto.randomUUID())},
          'cli_session', ${oldCliSessionId}, array['users:manage']::text[],
          ${stamp}::timestamptz, ${`cli_session:${oldCliSessionId}`}, ${userId}, ${expiry}::timestamptz
        )
      `
      await client!`
        insert into user_invites (id, token_digest, role, created_by_principal, created_at, expires_at)
        values (
          ${inviteId}, ${Buffer.from(crypto.randomUUID())}, 'admin', ${`api_token:${tokenId}`},
          ${stamp}::timestamptz, ${expiry}::timestamptz
        )
      `
      await client!`
        insert into device_authorizations (
          id, device_code_digest, user_code, scope_profile, client_name,
          installation_key, installation_name, platform, architecture,
          client_version, state, created_at, expires_at, polling_interval_seconds
        ) values (
          ${authorizationId}, ${Buffer.from(crypto.randomUUID())}, 'ABCD-EFGH',
          'administrator', 'pulsectl', ${installationKey}, 'laptop', 'test', 'test',
          '1.0', 'pending', ${stamp}::timestamptz, ${expiry}::timestamptz, 5
        )
      `

      await approveDeviceAuthorization(
        "ABCD-EFGH",
        {
          id: userId,
          sessionId: sessionB,
          email,
        },
        now
      )

      const [installation] = await client!`
        select authorized_by_human_session_id, revoked_at from cli_installations
        where id = ${installationId}
      `
      expect(installation?.authorized_by_human_session_id).toBe(sessionB)
      expect(installation?.revoked_at).toBeNull()
      for (const [table, id] of [
        ["cli_sessions", oldCliSessionId],
        ["api_tokens", tokenId],
        ["user_invites", inviteId],
      ] as const) {
        const [row] = await client!.unsafe(
          `select revoked_at from ${table} where id = $1`,
          [id]
        )
        expect(row?.revoked_at).toBeInstanceOf(Date)
      }

      await client!`
        insert into cli_sessions (
          id, installation_id, token_prefix, token_digest, user_email, scopes, created_at, expires_at
        ) values (
          ${newCliSessionId}, ${installationId}, 'pulse_cli', ${Buffer.from(crypto.randomUUID())},
          ${email}, array['users:manage']::text[], ${stamp}::timestamptz, ${expiry}::timestamptz
        )
      `
      await revokeAccountSession({
        userId,
        currentSessionId: sessionB,
        sessionId: sessionA,
      })
      const [newSession] = await client!`
        select revoked_at from cli_sessions where id = ${newCliSessionId}
      `
      expect(newSession?.revoked_at).toBeNull()
    } finally {
      await client!`delete from device_authorizations where id = ${authorizationId}`
      await client!`delete from user_invites where id = ${inviteId}`
      await client!`delete from api_tokens where id = ${tokenId}`
      await client!`delete from cli_sessions where installation_id = ${installationId}`
      await client!`delete from cli_installations where id = ${installationId}`
      await client!`delete from human_sessions where user_id = ${userId}`
      await client!`delete from admin_users where id = ${userId}`
    }
  })
})
