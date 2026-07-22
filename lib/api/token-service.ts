import { and, desc, eq, isNull, lt, or } from "drizzle-orm"

import { type DatabaseHandle, db } from "@/lib/db/client"
import { apiTokens } from "@/lib/db/schema"

import { type ApiScope, canDelegateScopes, normalizeScopes } from "./scopes"
import { createBearerToken } from "./tokens"

const MAX_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60_000
// Applied when a create request omits an explicit expiry. Callers that want a
// different lifetime pass expiresAt directly.
const DEFAULT_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60_000
// Kept below the creator's own expiry when a default is clamped so the child
// still expires strictly before its creator even with clock skew between mint
// and validation.
const CREATOR_LIFETIME_MARGIN_MS = 60_000

export interface TokenRecord {
  id: string
  name: string
  scopes: ApiScope[]
  createdAt: Date
  expiresAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}

export class TokenServiceError extends Error {
  constructor(
    readonly code: "INVALID_TOKEN" | "SCOPE_DENIED" | "TOKEN_NOT_FOUND",
    message: string
  ) {
    super(message)
    this.name = "TokenServiceError"
  }
}

export function validateTokenInput(
  input: unknown,
  principal: { type?: string; scopes: readonly string[]; expiresAt?: Date },
  now = new Date()
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TokenServiceError("INVALID_TOKEN", "Token details are required")
  }
  const value = input as Record<string, unknown>
  const allowedKeys = new Set(["name", "scopes", "expiresAt"])
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new TokenServiceError(
      "INVALID_TOKEN",
      "Token details contain unsupported fields"
    )
  }
  if (
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.trim().length > 120
  ) {
    throw new TokenServiceError(
      "INVALID_TOKEN",
      "Token name must contain 1 to 120 characters"
    )
  }
  if (
    !Array.isArray(value.scopes) ||
    value.scopes.length === 0 ||
    !value.scopes.every((scope) => typeof scope === "string")
  ) {
    throw new TokenServiceError(
      "INVALID_TOKEN",
      "At least one token scope is required"
    )
  }
  const requestedScopes = value.scopes as string[]
  if (
    new Set(requestedScopes).size !== requestedScopes.length ||
    !canDelegateScopes(principal, requestedScopes)
  ) {
    throw new TokenServiceError(
      "SCOPE_DENIED",
      "Requested scopes exceed the caller's effective scopes"
    )
  }
  // Only the human administrator may delegate the token-management and
  // user-management scopes. Machine credentials (api tokens, CLI sessions)
  // cannot mint children that themselves mint tokens or invite users, which
  // bounds any delegation chain to a single level and keeps cascade
  // revocation of a revoked parent complete.
  if (
    principal.type &&
    principal.type !== "human" &&
    (requestedScopes.includes("tokens:manage") ||
      requestedScopes.includes("users:manage"))
  ) {
    throw new TokenServiceError(
      "SCOPE_DENIED",
      "Machine credentials cannot delegate the tokens:manage or users:manage scopes"
    )
  }
  // No explicit expiry: apply the default lifetime, clamped down to the
  // creator's remaining lifetime (minus a safety margin) when the creator is
  // itself time-bounded. This keeps the common create path usable for CLI
  // sessions instead of rejecting it. An explicit expiry beyond the creator is
  // still an error below.
  if (value.expiresAt === undefined) {
    const target = new Date(now.getTime() + DEFAULT_TOKEN_LIFETIME_MS)
    let expiresAt = target
    let clamped = false
    if (principal.expiresAt) {
      const creatorBound = new Date(
        principal.expiresAt.getTime() - CREATOR_LIFETIME_MARGIN_MS
      )
      if (creatorBound < target) {
        expiresAt = creatorBound
        clamped = true
      }
    }
    if (expiresAt <= now) {
      throw new TokenServiceError(
        "INVALID_TOKEN",
        "The creating credential expires too soon to delegate a token"
      )
    }
    return {
      name: value.name.trim(),
      scopes: normalizeScopes(requestedScopes),
      expiresAt,
      clamped,
    }
  }
  if (typeof value.expiresAt !== "string") {
    throw new TokenServiceError(
      "INVALID_TOKEN",
      "Token expiry must be an ISO 8601 timestamp"
    )
  }
  const expiresAt = new Date(value.expiresAt)
  if (
    Number.isNaN(expiresAt.getTime()) ||
    expiresAt <= now ||
    expiresAt.getTime() > now.getTime() + MAX_TOKEN_LIFETIME_MS
  ) {
    throw new TokenServiceError(
      "INVALID_TOKEN",
      "Token expiry must be in the next 365 days"
    )
  }
  if (principal.expiresAt && expiresAt > principal.expiresAt) {
    throw new TokenServiceError(
      "INVALID_TOKEN",
      "A delegated token cannot outlive its creator"
    )
  }
  return {
    name: value.name.trim(),
    scopes: normalizeScopes(requestedScopes),
    expiresAt,
    clamped: false,
  }
}

export async function createApiToken(
  input: {
    name: string
    scopes: ApiScope[]
    expiresAt: Date
    principal: { type: string; id: string }
    credential?: ReturnType<typeof createBearerToken>
  },
  now = new Date(),
  handle: DatabaseHandle = db
): Promise<{ token: TokenRecord; secret: string }> {
  const credential = input.credential ?? createBearerToken()
  if (input.credential) {
    const [existing] = await handle
      .select(tokenSelection)
      .from(apiTokens)
      .where(eq(apiTokens.tokenDigest, credential.digest))
      .limit(1)
    if (existing) {
      return { token: serializeToken(existing), secret: credential.raw }
    }
  }
  const [row] = await handle
    .insert(apiTokens)
    .values({
      id: crypto.randomUUID(),
      name: input.name,
      tokenPrefix: credential.prefix,
      tokenDigest: credential.digest,
      principalType: input.principal.type,
      principalId: input.principal.id,
      scopes: input.scopes,
      createdAt: now,
      createdByPrincipal: `${input.principal.type}:${input.principal.id}`,
      expiresAt: input.expiresAt,
    })
    .returning(tokenSelection)
  // A single-row insert with returning always yields the inserted row.
  return { token: serializeToken(row!), secret: credential.raw }
}

export async function listApiTokens(input: {
  cursor: { sort: Date; id: string } | null
  limit: number
}) {
  // Cursor must be Date+UUID-validated by the route before this store call.
  const predicate = input.cursor
    ? or(
        lt(apiTokens.createdAt, input.cursor.sort),
        and(
          eq(apiTokens.createdAt, input.cursor.sort),
          lt(apiTokens.id, input.cursor.id)
        )
      )
    : undefined
  const rows = await db
    .select(tokenSelection)
    .from(apiTokens)
    .where(predicate)
    .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id))
    .limit(input.limit + 1)
  const page = rows.slice(0, input.limit).map(serializeToken)
  const final = page.at(-1)
  return {
    tokens: page,
    nextCursor:
      rows.length > input.limit && final
        ? { sort: final.createdAt.toISOString(), id: final.id }
        : null,
  }
}

export async function revokeApiToken(
  tokenId: string,
  now = new Date(),
  handle: DatabaseHandle = db
): Promise<TokenRecord | null> {
  return handle.transaction(async (tx) => {
    const [row] = await tx
      .update(apiTokens)
      .set({ revokedAt: now })
      .where(and(eq(apiTokens.id, tokenId), isNull(apiTokens.revokedAt)))
      .returning(tokenSelection)
    // Cascade to any tokens this token minted so a revoked parent cannot leave a live
    // descendant foothold. The delegation policy bounds the tree to one level below a
    // machine credential, so this single sweep covers the whole subtree.
    await tx
      .update(apiTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(apiTokens.createdByPrincipal, `api_token:${tokenId}`),
          isNull(apiTokens.revokedAt)
        )
      )
    if (row) {
      return serializeToken(row)
    }
    const [existing] = await tx
      .select(tokenSelection)
      .from(apiTokens)
      .where(eq(apiTokens.id, tokenId))
      .limit(1)
    return existing ? serializeToken(existing) : null
  })
}

const tokenSelection = {
  id: apiTokens.id,
  name: apiTokens.name,
  scopes: apiTokens.scopes,
  createdAt: apiTokens.createdAt,
  expiresAt: apiTokens.expiresAt,
  lastUsedAt: apiTokens.lastUsedAt,
  revokedAt: apiTokens.revokedAt,
}

function serializeToken(row: {
  id: string
  name: string
  scopes: string[]
  createdAt: Date
  expiresAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}): TokenRecord {
  return { ...row, scopes: normalizeScopes(row.scopes) }
}
