import "server-only"

import { and, eq, gt, isNull, lt, or } from "drizzle-orm"
import { after } from "next/server"

import { authenticateCurrentSession } from "@/lib/auth/session"
import { db } from "@/lib/db/client"
import { apiTokens, cliInstallations, cliSessions } from "@/lib/db/schema"

import {
  ADMINISTRATOR_SCOPES,
  type ApiScope,
  normalizeScopes,
  resolveScopeProfile,
} from "./scopes"
import { digestBearerToken, parseBearerAuthorization } from "./tokens"

export interface HumanPrincipal {
  type: "human"
  id: string
  email: string
  scopes: ApiScope[]
}

interface ApiTokenPrincipal {
  type: "api_token"
  id: string
  name: string
  scopes: ApiScope[]
  expiresAt: Date
}

interface CliSessionPrincipal {
  type: "cli_session"
  id: string
  email: string
  scopes: ApiScope[]
  expiresAt: Date
  installation: {
    id: string
    displayName: string
    platform: string
    architecture: string
    clientVersion: string
    linkedAt: Date
  }
}

export type Principal = HumanPrincipal | ApiTokenPrincipal | CliSessionPrincipal

export interface PrincipalStore {
  findApiToken: (digest: Buffer, now: Date) => Promise<ApiTokenPrincipal | null>
  findCliSession: (
    digest: Buffer,
    now: Date
  ) => Promise<CliSessionPrincipal | null>
  recordApiTokenUse: (id: string, now: Date) => Promise<void>
  recordCliSessionUse: (
    id: string,
    installationId: string,
    now: Date
  ) => Promise<void>
}

type HumanSession = Awaited<ReturnType<typeof authenticateCurrentSession>>

export async function authenticatePrincipal(
  request: Request,
  dependencies: {
    store?: PrincipalStore
    authenticateHumanSession?: () => Promise<HumanSession>
    now?: () => Date
  } = {}
): Promise<Principal | null> {
  const raw = parseBearerAuthorization(request.headers.get("authorization"))
  if (!raw) {
    if (request.headers.has("authorization")) {
      return null
    }
    const session = await (
      dependencies.authenticateHumanSession ?? authenticateCurrentSession
    )()
    return session
      ? {
          type: "human",
          id: session.userId,
          email: session.email,
          scopes: [...ADMINISTRATOR_SCOPES],
        }
      : null
  }

  const store = dependencies.store ?? databasePrincipalStore
  const now = dependencies.now?.() ?? new Date()
  const digest = digestBearerToken(raw)
  const apiToken = await store.findApiToken(digest, now)
  if (apiToken) {
    await deferTouch(() => store.recordApiTokenUse(apiToken.id, now))
    return apiToken
  }
  const cliSession = await store.findCliSession(digest, now)
  if (cliSession) {
    await deferTouch(() =>
      store.recordCliSessionUse(cliSession.id, cliSession.installation.id, now)
    )
    return cliSession
  }
  return null
}

const LAST_USED_WRITE_INTERVAL_MS = 5 * 60_000

const databasePrincipalStore: PrincipalStore = {
  async findApiToken(digest, now) {
    const [row] = await db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        scopes: apiTokens.scopes,
        expiresAt: apiTokens.expiresAt,
      })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.tokenDigest, digest),
          isNull(apiTokens.revokedAt),
          gt(apiTokens.expiresAt, now)
        )
      )
      .limit(1)
    return row
      ? { type: "api_token", ...row, scopes: normalizeScopes(row.scopes) }
      : null
  },

  async findCliSession(digest, now) {
    const [row] = await db
      .select({
        id: cliSessions.id,
        email: cliSessions.userEmail,
        scopes: cliSessions.scopes,
        scopeProfile: cliSessions.scopeProfile,
        expiresAt: cliSessions.expiresAt,
        installationId: cliInstallations.id,
        displayName: cliInstallations.displayName,
        platform: cliInstallations.platform,
        architecture: cliInstallations.architecture,
        clientVersion: cliInstallations.clientVersion,
        linkedAt: cliInstallations.linkedAt,
      })
      .from(cliSessions)
      .innerJoin(
        cliInstallations,
        eq(cliInstallations.id, cliSessions.installationId)
      )
      .where(
        and(
          eq(cliSessions.tokenDigest, digest),
          isNull(cliSessions.revokedAt),
          gt(cliSessions.expiresAt, now),
          isNull(cliInstallations.revokedAt)
        )
      )
      .limit(1)
    return row
      ? {
          type: "cli_session",
          id: row.id,
          email: row.email,
          // Auth-time profile resolution: a stored scope profile wins over the
          // literal mint-time snapshot so existing sessions gain new scopes.
          scopes:
            resolveScopeProfile(row.scopeProfile) ??
            normalizeScopes(row.scopes),
          expiresAt: row.expiresAt,
          installation: {
            id: row.installationId,
            displayName: row.displayName,
            platform: row.platform,
            architecture: row.architecture,
            clientVersion: row.clientVersion,
            linkedAt: row.linkedAt,
          },
        }
      : null
  },

  async recordApiTokenUse(id, now) {
    await db
      .update(apiTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(apiTokens.id, id),
          isNull(apiTokens.revokedAt),
          gt(apiTokens.expiresAt, now),
          or(
            isNull(apiTokens.lastUsedAt),
            lt(
              apiTokens.lastUsedAt,
              new Date(now.getTime() - LAST_USED_WRITE_INTERVAL_MS)
            )
          )
        )
      )
  },

  async recordCliSessionUse(id, installationId, now) {
    const staleBefore = new Date(now.getTime() - LAST_USED_WRITE_INTERVAL_MS)
    await Promise.all([
      db
        .update(cliSessions)
        .set({ lastUsedAt: now })
        .where(
          and(
            eq(cliSessions.id, id),
            isNull(cliSessions.revokedAt),
            gt(cliSessions.expiresAt, now),
            or(
              isNull(cliSessions.lastUsedAt),
              lt(cliSessions.lastUsedAt, staleBefore)
            )
          )
        ),
      db
        .update(cliInstallations)
        .set({ lastSeenAt: now })
        .where(
          and(
            eq(cliInstallations.id, installationId),
            isNull(cliInstallations.revokedAt),
            or(
              isNull(cliInstallations.lastSeenAt),
              lt(cliInstallations.lastSeenAt, staleBefore)
            )
          )
        ),
    ])
  },
}

// Touches are best-effort and run outside the response path.
function deferTouch(touch: () => Promise<void>): Promise<void> {
  try {
    after(() => safeTouch(touch))
    return Promise.resolve()
  } catch {
    // after() requires a request scope. Direct callers update inline.
    return safeTouch(touch)
  }
}

async function safeTouch(touch: () => Promise<void>) {
  await touch().catch(() => undefined)
}
