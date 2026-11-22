import "server-only"

import { and, eq, gt, isNull, sql } from "drizzle-orm"

import { lockMachineCredentialChanges } from "@/lib/api/machine-credential-lock"
import type { DatabaseHandle } from "@/lib/db/client"
import {
  adminUsers,
  apiTokens,
  cliInstallations,
  cliSessions,
  humanSessions,
} from "@/lib/db/schema"

import type { Principal } from "./principal"
import {
  type ApiScope,
  normalizeScopes,
  resolveScopeProfile,
  roleScopes,
} from "./scopes"

/**
 * Rechecks a route principal under locks held through the caller's transaction.
 * Team changes take team then machine; using the same order makes an in-flight
 * write linearize before or after demotion, removal, or credential rotation.
 * A mutation that performs a bounded provider call before commit holds these
 * locks for that call as well, so revocation can wait for its timeout.
 */
export async function hasLiveScope(
  tx: DatabaseHandle,
  principal: Principal,
  scope: ApiScope
): Promise<boolean> {
  if (!("rollback" in tx)) {
    throw new Error("Live authority check requires a transaction")
  }
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('pulse:team-roles'))`
  )
  await lockMachineCredentialChanges(tx)
  const now = new Date()

  if (principal.type === "human") {
    const [row] = await tx
      .select({ role: adminUsers.role })
      .from(humanSessions)
      .innerJoin(adminUsers, eq(adminUsers.id, humanSessions.userId))
      .where(
        and(
          eq(humanSessions.id, principal.sessionId),
          eq(humanSessions.userId, principal.id),
          isNull(humanSessions.revokedAt),
          gt(humanSessions.expiresAt, now)
        )
      )
      .for("update")
      .limit(1)
    return Boolean(row && roleScopes(row.role).includes(scope))
  }

  if (principal.type === "api_token") {
    const [row] = await tx
      .select({ scopes: apiTokens.scopes })
      .from(apiTokens)
      .innerJoin(adminUsers, eq(adminUsers.id, apiTokens.credentialOwnerUserId))
      .where(
        and(
          eq(apiTokens.id, principal.id),
          isNull(apiTokens.revokedAt),
          gt(apiTokens.expiresAt, now),
          eq(apiTokens.credentialEpoch, adminUsers.credentialEpoch)
        )
      )
      .for("update")
      .limit(1)
    return Boolean(row && normalizeScopes(row.scopes).includes(scope))
  }

  const [row] = await tx
    .select({ scopes: cliSessions.scopes, profile: cliSessions.scopeProfile })
    .from(cliSessions)
    .innerJoin(
      cliInstallations,
      eq(cliInstallations.id, cliSessions.installationId)
    )
    .innerJoin(adminUsers, eq(adminUsers.id, cliInstallations.userId))
    .where(
      and(
        eq(cliSessions.id, principal.id),
        isNull(cliSessions.revokedAt),
        gt(cliSessions.expiresAt, now),
        isNull(cliInstallations.revokedAt),
        eq(cliInstallations.credentialEpoch, adminUsers.credentialEpoch)
      )
    )
    .for("update")
    .limit(1)
  return Boolean(
    row &&
      (
        resolveScopeProfile(row.profile) ?? normalizeScopes(row.scopes)
      ).includes(scope)
  )
}
