import "server-only"

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm"

import type { DatabaseTransaction } from "@/lib/db/client"
import { apiTokens, cliInstallations, cliSessions } from "@/lib/db/schema"

export async function revokeUserMachineCredentials(
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
    update ${apiTokens}
    set revoked_at = ${input.now}
    where id in (select id from token_tree)
      and revoked_at is null
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
  if (installationIds.length > 0) {
    await tx
      .update(cliSessions)
      .set({ revokedAt: input.now })
      .where(
        and(
          inArray(cliSessions.installationId, installationIds),
          isNull(cliSessions.revokedAt)
        )
      )
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
    set revoked_at = ${now}
    where id in (select id from token_tree)
      and revoked_at is null
    returning id
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
    set revoked_at = ${now}
    where id in (select id from token_tree)
      and revoked_at is null
    returning id
  `)
  return (rows as unknown as unknown[]).length
}
