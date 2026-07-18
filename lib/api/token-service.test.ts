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
});
