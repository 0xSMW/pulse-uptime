export const API_SCOPES = [
  "monitors:read",
  "monitors:write",
  "incidents:read",
  "config:read",
  "config:write",
  "notifications:test",
  "tokens:manage",
  "status:read",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export const ADMINISTRATOR_SCOPES: readonly ApiScope[] = API_SCOPES;

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
