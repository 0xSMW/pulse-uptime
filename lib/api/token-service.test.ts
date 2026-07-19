import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ db: {} }));

import { TokenServiceError, validateTokenInput } from "./token-service";

const now = new Date("2026-07-18T00:00:00.000Z");
const principal = { scopes: ["monitors:read", "tokens:manage"] };

describe("token request validation", () => {
  it("accepts delegated scopes and a bounded future expiry", () => {
    expect(validateTokenInput({
      name: "Deploy agent",
      scopes: ["monitors:read"],
      expiresAt: "2026-09-01T00:00:00.000Z",
    }, principal, now)).toEqual({
      name: "Deploy agent",
      scopes: ["monitors:read"],
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    });
  });

  it("rejects broader scopes and expiries beyond policy", () => {
    expect(() => validateTokenInput({
      name: "Escalation",
      scopes: ["config:write"],
      expiresAt: "2026-08-01T00:00:00.000Z",
    }, principal, now)).toThrow(TokenServiceError);
    expect(() => validateTokenInput({
      name: "Long lived",
      scopes: ["monitors:read"],
      expiresAt: "2027-08-01T00:00:00.000Z",
    }, principal, now)).toThrow(TokenServiceError);
  });

  it("prevents token-authenticated callers from delegating past their own expiry", () => {
    expect(() => validateTokenInput({
      name: "Child",
      scopes: ["monitors:read"],
      expiresAt: "2026-09-01T00:00:00.000Z",
    }, { ...principal, expiresAt: new Date("2026-08-01T00:00:00.000Z") }, now)).toThrow(/cannot outlive/);
  });

  it("forbids machine credentials from delegating tokens:manage", () => {
    const machine = { type: "api_token", scopes: ["monitors:read", "tokens:manage"], expiresAt: new Date("2026-12-01T00:00:00.000Z") };
    expect(() => validateTokenInput({
      name: "Grandchild minter",
      scopes: ["tokens:manage"],
      expiresAt: "2026-09-01T00:00:00.000Z",
    }, machine, now)).toThrow(/cannot delegate the tokens:manage scope/);
    // The same machine credential may still delegate non-minting scopes.
    expect(validateTokenInput({
      name: "Reader",
      scopes: ["monitors:read"],
      expiresAt: "2026-09-01T00:00:00.000Z",
    }, machine, now).scopes).toEqual(["monitors:read"]);
  });

  it("allows the human administrator to delegate tokens:manage", () => {
    expect(validateTokenInput({
      name: "Deploy admin",
      scopes: ["tokens:manage"],
      expiresAt: "2026-09-01T00:00:00.000Z",
    }, { type: "human", scopes: ["monitors:read", "tokens:manage"] }, now).scopes).toEqual(["tokens:manage"]);
  });
});
