export const API_SCOPES = [
  "monitors:read",
  "monitors:write",
  "incidents:read",
  "config:read",
  "config:write",
  "notifications:test",
  "tokens:manage",
  "status:read",
  "reports:read",
  "reports:write",
  "dependencies:read",
  "dependencies:write",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export const ADMINISTRATOR_SCOPES: readonly ApiScope[] = API_SCOPES;

/**
 * Named scope profiles are resolved at AUTH time, not at mint time: a CLI
 * session that stores the "administrator" profile gains newly introduced
 * scopes automatically instead of being stranded on its snapshot.
 */
export const SCOPE_PROFILES: Readonly<Record<string, readonly ApiScope[]>> = {
  administrator: ADMINISTRATOR_SCOPES,
};

export function resolveScopeProfile(profile: string | null | undefined): ApiScope[] | null {
  if (!profile) return null;
  const scopes = SCOPE_PROFILES[profile];
  return scopes ? [...scopes] : null;
}

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

export function normalizeScopes(scopes: readonly string[]): ApiScope[] {
  const supplied = new Set(scopes);
  return API_SCOPES.filter((scope) => supplied.has(scope));
}

export function hasScope(
  principal: { scopes: readonly string[] },
  required: ApiScope,
): boolean {
  return principal.scopes.includes(required);
}

export function canDelegateScopes(
  principal: { scopes: readonly string[] },
  requested: readonly string[],
): requested is readonly ApiScope[] {
  return requested.every(
    (scope) => isApiScope(scope) && principal.scopes.includes(scope),
  );
}
