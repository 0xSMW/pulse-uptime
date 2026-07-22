/** @public Canonical registry of every API scope. The ApiScope type and all scope validation derive from this list. */
export const API_SCOPES = [
  "monitors:read",
  "monitors:write",
  "incidents:read",
  "config:read",
  "config:write",
  "notifications:test",
  "tokens:manage",
  "users:manage",
  "status:read",
  "reports:read",
  "reports:write",
  "dependencies:read",
  "dependencies:write",
] as const

export type ApiScope = (typeof API_SCOPES)[number]

export const ADMINISTRATOR_SCOPES: readonly ApiScope[] = [...API_SCOPES]

/** Every read-only scope. Viewers observe the whole install but mutate nothing. */
export const VIEWER_SCOPES: readonly ApiScope[] = API_SCOPES.filter((scope) =>
  scope.endsWith(":read")
)

export const USER_ROLES = ["admin", "viewer"] as const

export type UserRole = (typeof USER_ROLES)[number]

export function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value)
}

/**
 * Effective scopes for a human session. Unknown values from the database fall
 * back to viewer so a bad row can never widen access.
 */
export function roleScopes(role: string): ApiScope[] {
  return role === "admin" ? [...ADMINISTRATOR_SCOPES] : [...VIEWER_SCOPES]
}

/**
 * Named scope profiles are resolved at AUTH time, not at mint time: a CLI
 * session that stores the "administrator" profile gains newly introduced
 * scopes automatically instead of being stranded on its snapshot.
 */
const SCOPE_PROFILES: Readonly<Record<string, readonly ApiScope[]>> = {
  administrator: ADMINISTRATOR_SCOPES,
  viewer: VIEWER_SCOPES,
}

export function resolveScopeProfile(
  profile: string | null | undefined
): ApiScope[] | null {
  if (!profile) {
    return null
  }
  const scopes = SCOPE_PROFILES[profile]
  return scopes ? [...scopes] : null
}

function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value)
}

export function normalizeScopes(scopes: readonly string[]): ApiScope[] {
  const supplied = new Set(scopes)
  return API_SCOPES.filter((scope) => supplied.has(scope))
}

export function hasScope(
  principal: { scopes: readonly string[] },
  required: ApiScope
): boolean {
  return principal.scopes.includes(required)
}

export function canDelegateScopes(
  principal: { scopes: readonly string[] },
  requested: readonly string[]
): requested is readonly ApiScope[] {
  return requested.every(
    (scope) => isApiScope(scope) && principal.scopes.includes(scope)
  )
}
