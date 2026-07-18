import { describe, expect, it } from "vitest";

import {
  ADMINISTRATOR_SCOPES,
  canDelegateScopes,
  hasScope,
  normalizeScopes,
} from "./scopes";

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
      "status:read",
    ]);
  });

  it("checks access and delegated subsets", () => {
    const principal = { scopes: ["monitors:read", "tokens:manage"] };
    expect(hasScope(principal, "monitors:read")).toBe(true);
    expect(hasScope(principal, "config:write")).toBe(false);
    expect(canDelegateScopes(principal, ["tokens:manage"])).toBe(true);
    expect(canDelegateScopes(principal, ["tokens:manage", "status:read"])).toBe(false);
    expect(canDelegateScopes(principal, ["not:a-scope"])).toBe(false);
  });

  it("drops unknown scopes and returns canonical ordering", () => {
    expect(normalizeScopes(["status:read", "future:scope", "monitors:read"]))
      .toEqual(["monitors:read", "status:read"]);
  });
});
