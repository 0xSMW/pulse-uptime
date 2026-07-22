import { describe, expect, it } from "vitest"

import {
  ADMINISTRATOR_SCOPES,
  canDelegateScopes,
  hasScope,
  isUserRole,
  normalizeScopes,
  resolveScopeProfile,
  roleScopes,
  VIEWER_SCOPES,
} from "./scopes"

describe("API scopes", () => {
  it("defines the complete administrator scope snapshot", () => {
    expect(ADMINISTRATOR_SCOPES).toEqual([
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
    ])
  })

  it("limits viewers to exactly the read scopes", () => {
    expect(VIEWER_SCOPES).toEqual([
      "monitors:read",
      "incidents:read",
      "config:read",
      "status:read",
      "reports:read",
      "dependencies:read",
    ])
    for (const scope of VIEWER_SCOPES) {
      expect(scope.endsWith(":read")).toBe(true)
    }
  })

  it("resolves the administrator profile to the live scope list at auth time", () => {
    expect(resolveScopeProfile("administrator")).toEqual([
      ...ADMINISTRATOR_SCOPES,
    ])
    expect(resolveScopeProfile("administrator")).toContain("reports:write")
    expect(resolveScopeProfile("viewer")).toEqual([...VIEWER_SCOPES])
    expect(resolveScopeProfile(null)).toBeNull()
    expect(resolveScopeProfile(undefined)).toBeNull()
    expect(resolveScopeProfile("intern")).toBeNull()
  })

  it("maps roles to scopes and narrows unknown roles to viewer", () => {
    expect(roleScopes("admin")).toEqual([...ADMINISTRATOR_SCOPES])
    expect(roleScopes("viewer")).toEqual([...VIEWER_SCOPES])
    expect(roleScopes("superuser")).toEqual([...VIEWER_SCOPES])
    expect(isUserRole("admin")).toBe(true)
    expect(isUserRole("viewer")).toBe(true)
    expect(isUserRole("owner")).toBe(false)
  })

  it("checks access and delegated subsets", () => {
    const principal = { scopes: ["monitors:read", "tokens:manage"] }
    expect(hasScope(principal, "monitors:read")).toBe(true)
    expect(hasScope(principal, "config:write")).toBe(false)
    expect(canDelegateScopes(principal, ["tokens:manage"])).toBe(true)
    expect(canDelegateScopes(principal, ["tokens:manage", "status:read"])).toBe(
      false
    )
    expect(canDelegateScopes(principal, ["not:a-scope"])).toBe(false)
  })

  it("drops unknown scopes and returns canonical ordering", () => {
    expect(
      normalizeScopes(["status:read", "future:scope", "monitors:read"])
    ).toEqual(["monitors:read", "status:read"])
  })
})
