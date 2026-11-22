import "server-only"

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm"

import type { DatabaseTransaction } from "@/lib/db/client"
import {
  apiTokens,
  cliInstallations,
  cliSessions,
  userInvites,
} from "@/lib/db/schema"

/** Contain credentials issued under explicitly revoked human sessions. */
export async function revokeHumanSessionIssuedCredentials(
  tx: DatabaseTransaction,
  sessionIds: readonly string[],
  now: Date
): Promise<void> {
  if (sessionIds.length === 0) {
    return
  }
  const sessionList = sql.join(
    sessionIds.map((id) => sql`${id}::uuid`),
    sql`, `
  )
  await tx.execute(sql`
    with recursive installation_sessions(id) as (
      select session.id from ${cliSessions} as session
      inner join ${cliInstallations} as installation
        on installation.id = session.installation_id
      where installation.authorized_by_human_session_id in (${sessionList})
    ), token_tree(id) as (
      select token.id from ${apiTokens} as token
      where token.issued_by_human_session_id in (${sessionList})
         or token.created_by_principal in (
           select 'cli_session:' || installation_sessions.id::text
           from installation_sessions
         )
      union
      select child.id from ${apiTokens} as child
      inner join token_tree as parent
        on child.created_by_principal = 'api_token:' || parent.id::text
    )
    update ${apiTokens}
    set revoked_at = ${now.toISOString()}::timestamptz
    where id in (select id from token_tree)
      and revoked_at is null
  `)
  await tx.execute(sql`
    with recursive installation_sessions(id) as (
      select session.id from ${cliSessions} as session
      inner join ${cliInstallations} as installation
        on installation.id = session.installation_id
      where installation.authorized_by_human_session_id in (${sessionList})
    ), token_tree(id) as (
      select token.id from ${apiTokens} as token
      where token.issued_by_human_session_id in (${sessionList})
         or token.created_by_principal in (
           select 'cli_session:' || installation_sessions.id::text
           from installation_sessions
         )
      union
      select child.id from ${apiTokens} as child
      inner join token_tree as parent
        on child.created_by_principal = 'api_token:' || parent.id::text
    )
    update ${userInvites} as invite
    set revoked_at = ${now.toISOString()}::timestamptz
    where invite.accepted_at is null
      and invite.revoked_at is null
      and (
        invite.issued_by_human_session_id in (${sessionList})
        or invite.created_by_principal in (
          select 'cli_session:' || installation_sessions.id::text
          from installation_sessions
        )
        or invite.created_by_principal in (
          select 'api_token:' || token_tree.id::text from token_tree
        )
      )
  `)
  await tx
    .update(cliSessions)
    .set({ revokedAt: now })
    .where(
      and(
        inArray(
          cliSessions.installationId,
          tx
            .select({ id: cliInstallations.id })
            .from(cliInstallations)
            .where(
              inArray(cliInstallations.authorizedByHumanSessionId, sessionIds)
            )
        ),
        isNull(cliSessions.revokedAt)
      )
    )
  await tx
    .update(cliInstallations)
    .set({ revokedAt: now })
    .where(
      and(
        inArray(cliInstallations.authorizedByHumanSessionId, sessionIds),
        isNull(cliInstallations.revokedAt)
      )
    )
}

export async function revokeUserMachineCredentials(
  tx: DatabaseTransaction,
  input: { userId: string; userEmail: string; now: Date }
): Promise<{ revokedCliSessions: number; revokedApiTokens: number }> {
  const revokedTokens = await tx.execute(sql`
    with recursive token_tree(id) as (
      select token.id
      from ${apiTokens} as token
      where token.credential_owner_user_id = ${input.userId}
         or token.created_by_principal = ${`human:${input.userId}`}
         or token.created_by_principal in (
           select 'cli_session:' || session.id::text
           from ${cliSessions} as session
           inner join ${cliInstallations} as installation
             on installation.id = session.installation_id
           where installation.user_id = ${input.userId}
              or installation.user_email = ${input.userEmail}
         )
      union
      select child.id
      from ${apiTokens} as child
      inner join token_tree as parent
        on child.created_by_principal = 'api_token:' || parent.id::text
    )
    update ${apiTokens}
    set revoked_at = ${input.now.toISOString()}::timestamptz
    where id in (select id from token_tree)
      and revoked_at is null
    returning id
  `)

  const installations = await tx
    .select({ id: cliInstallations.id })
    .from(cliInstallations)
    .where(
      or(
        eq(cliInstallations.userId, input.userId),
        eq(cliInstallations.userEmail, input.userEmail)
      )
    )
  const installationIds = installations.map((row) => row.id)
  let revokedSessionCount = 0
  if (installationIds.length > 0) {
    const revokedSessions = await tx
      .update(cliSessions)
      .set({ revokedAt: input.now })
      .where(
        and(
          inArray(cliSessions.installationId, installationIds),
          isNull(cliSessions.revokedAt)
        )
      )
      .returning({ id: cliSessions.id })
    revokedSessionCount = revokedSessions.length
  }
  await tx
    .update(cliInstallations)
    .set({ revokedAt: input.now })
    .where(
      and(
        or(
          eq(cliInstallations.userId, input.userId),
          eq(cliInstallations.userEmail, input.userEmail)
        ),
        isNull(cliInstallations.revokedAt)
      )
    )
  await revokeUserPendingInvites(tx, input)
  return {
    revokedCliSessions: revokedSessionCount,
    revokedApiTokens: (revokedTokens as unknown as unknown[]).length,
  }
}

/** Remove stale admin-join paths after a security credential rotation. */
export async function revokeUserPendingInvites(
  tx: DatabaseTransaction,
  input: { userId: string; userEmail: string; now: Date }
): Promise<void> {
  await tx.execute(sql`
    with recursive token_tree(id) as (
      select token.id
      from ${apiTokens} as token
      where token.credential_owner_user_id = ${input.userId}
         or token.created_by_principal = ${`human:${input.userId}`}
         or token.created_by_principal in (
           select 'cli_session:' || session.id::text
           from ${cliSessions} as session
           inner join ${cliInstallations} as installation
             on installation.id = session.installation_id
           where installation.user_id = ${input.userId}
              or installation.user_email = ${input.userEmail}
         )
      union
      select child.id
      from ${apiTokens} as child
      inner join token_tree as parent
        on child.created_by_principal = 'api_token:' || parent.id::text
    )
    update ${userInvites} as invite
    set revoked_at = ${input.now.toISOString()}::timestamptz
    where invite.accepted_at is null
      and invite.revoked_at is null
      and (
        invite.created_by_principal = ${`human:${input.userId}`}
        or invite.created_by_principal in (
          select 'cli_session:' || session.id::text
          from ${cliSessions} as session
          inner join ${cliInstallations} as installation
            on installation.id = session.installation_id
          where installation.user_id = ${input.userId}
             or installation.user_email = ${input.userEmail}
        )
        or invite.created_by_principal in (
          select 'api_token:' || token_tree.id::text from token_tree
        )
      )
  `)
}

export async function revokeApiTokenSubtree(
  tx: DatabaseTransaction,
  tokenId: string,
  now: Date
): Promise<number> {
  const rows = await tx.execute(sql`
    with recursive token_tree(id) as (
      select ${tokenId}::uuid
      union
      select child.id
      from ${apiTokens} as child
      inner join token_tree as parent
        on child.created_by_principal = 'api_token:' || parent.id::text
    )
    update ${apiTokens}
    set revoked_at = ${now.toISOString()}::timestamptz
    where id in (select id from token_tree)
      and revoked_at is null
    returning id
  `)
  await tx.execute(sql`
    with recursive token_tree(id) as (
      select ${tokenId}::uuid
      union
      select child.id
      from ${apiTokens} as child
      inner join token_tree as parent
        on child.created_by_principal = 'api_token:' || parent.id::text
    )
    update ${userInvites} as invite
    set revoked_at = ${now.toISOString()}::timestamptz
    where invite.accepted_at is null
      and invite.revoked_at is null
      and invite.created_by_principal in (
        select 'api_token:' || token_tree.id::text from token_tree
      )
  `)
  return (rows as unknown as unknown[]).length
}

export async function revokeCliTokenSubtrees(
  tx: DatabaseTransaction,
  sessionIds: readonly string[],
  now: Date
): Promise<number> {
  if (sessionIds.length === 0) {
    return 0
  }
  const creatorKeys = sessionIds.map((id) => `cli_session:${id}`)
  const creatorList = sql.join(
    creatorKeys.map((key) => sql`${key}`),
    sql`, `
  )
  const rows = await tx.execute(sql`
    with recursive token_tree(id) as (
      select token.id
      from ${apiTokens} as token
      where token.created_by_principal in (${creatorList})
      union
      select child.id
      from ${apiTokens} as child
      inner join token_tree as parent
        on child.created_by_principal = 'api_token:' || parent.id::text
    )
    update ${apiTokens}
    set revoked_at = ${now.toISOString()}::timestamptz
    where id in (select id from token_tree)
      and revoked_at is null
    returning id
  `)
  await tx.execute(sql`
    with recursive token_tree(id) as (
      select token.id
      from ${apiTokens} as token
      where token.created_by_principal in (${creatorList})
      union
      select child.id
      from ${apiTokens} as child
      inner join token_tree as parent
        on child.created_by_principal = 'api_token:' || parent.id::text
    )
    update ${userInvites} as invite
    set revoked_at = ${now.toISOString()}::timestamptz
    where invite.accepted_at is null
      and invite.revoked_at is null
      and (
        invite.created_by_principal in (${creatorList})
        or invite.created_by_principal in (
          select 'api_token:' || token_tree.id::text from token_tree
        )
      )
  `)
  return (rows as unknown as unknown[]).length
}
