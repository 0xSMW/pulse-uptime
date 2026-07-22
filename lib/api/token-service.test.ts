import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: {} }))

import { TokenServiceError, validateTokenInput } from "./token-service"

const now = new Date("2026-07-18T00:00:00.000Z")
const principal = { scopes: ["monitors:read", "tokens:manage"] }

describe("token request validation", () => {
  it("accepts delegated scopes and a bounded future expiry", () => {
    expect(
      validateTokenInput(
        {
          name: "Deploy agent",
          scopes: ["monitors:read"],
          expiresAt: "2026-09-01T00:00:00.000Z",
        },
        principal,
        now
      )
    ).toEqual({
      name: "Deploy agent",
      scopes: ["monitors:read"],
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      clamped: false,
    })
  })

  it("rejects broader scopes and expiries beyond policy", () => {
    expect(() =>
      validateTokenInput(
        {
          name: "Escalation",
          scopes: ["config:write"],
          expiresAt: "2026-08-01T00:00:00.000Z",
        },
        principal,
        now
      )
    ).toThrow(TokenServiceError)
    expect(() =>
      validateTokenInput(
        {
          name: "Long lived",
          scopes: ["monitors:read"],
          expiresAt: "2027-08-01T00:00:00.000Z",
        },
        principal,
        now
      )
    ).toThrow(TokenServiceError)
  })

  it("prevents token-authenticated callers from delegating past their own expiry", () => {
    expect(() =>
      validateTokenInput(
        {
          name: "Child",
          scopes: ["monitors:read"],
          expiresAt: "2026-09-01T00:00:00.000Z",
        },
        { ...principal, expiresAt: new Date("2026-08-01T00:00:00.000Z") },
        now
      )
    ).toThrow(/cannot outlive/)
  })

  it("forbids machine credentials from delegating tokens:manage and users:manage", () => {
    const machine = {
      type: "api_token",
      scopes: ["monitors:read", "tokens:manage", "users:manage"],
      expiresAt: new Date("2026-12-01T00:00:00.000Z"),
    }
    expect(() =>
      validateTokenInput(
        {
          name: "Grandchild minter",
          scopes: ["tokens:manage"],
          expiresAt: "2026-09-01T00:00:00.000Z",
        },
        machine,
        now
      )
    ).toThrow(/cannot delegate the tokens:manage or users:manage scopes/)
    expect(() =>
      validateTokenInput(
        {
          name: "Inviter",
          scopes: ["users:manage"],
          expiresAt: "2026-09-01T00:00:00.000Z",
        },
        machine,
        now
      )
    ).toThrow(/cannot delegate the tokens:manage or users:manage scopes/)
    // The same machine credential may still delegate non-minting scopes.
    expect(
      validateTokenInput(
        {
          name: "Reader",
          scopes: ["monitors:read"],
          expiresAt: "2026-09-01T00:00:00.000Z",
        },
        machine,
        now
      ).scopes
    ).toEqual(["monitors:read"])
  })

  it("allows the human administrator to delegate tokens:manage", () => {
    expect(
      validateTokenInput(
        {
          name: "Deploy admin",
          scopes: ["tokens:manage"],
          expiresAt: "2026-09-01T00:00:00.000Z",
        },
        { type: "human", scopes: ["monitors:read", "tokens:manage"] },
        now
      ).scopes
    ).toEqual(["tokens:manage"])
  })

  it("applies the default lifetime when no expiry is requested and the creator is unbounded", () => {
    const result = validateTokenInput(
      { name: "Default", scopes: ["monitors:read"] },
      principal,
      now
    )
    // 90 days after now, no clamp because the creator has no expiry.
    expect(result.expiresAt).toEqual(new Date("2026-10-16T00:00:00.000Z"))
    expect(result.clamped).toBe(false)
  })

  it("clamps the default below a time-bounded creator instead of rejecting", () => {
    const creator = {
      ...principal,
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
    }
    const result = validateTokenInput(
      { name: "CLI child", scopes: ["monitors:read"] },
      creator,
      now
    )
    // Clamped to the creator expiry minus the one minute safety margin.
    expect(result.clamped).toBe(true)
    expect(result.expiresAt).toEqual(new Date("2026-07-31T23:59:00.000Z"))
    expect(result.expiresAt.getTime()).toBeLessThan(creator.expiresAt.getTime())
  })

  it("still rejects an explicit expiry beyond a time-bounded creator", () => {
    const creator = {
      ...principal,
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
    }
    expect(() =>
      validateTokenInput(
        {
          name: "Too long",
          scopes: ["monitors:read"],
          expiresAt: "2026-09-01T00:00:00.000Z",
        },
        creator,
        now
      )
    ).toThrow(/cannot outlive/)
  })

  it("does not clamp the default for a token principal creator that outlives it", () => {
    const creator = {
      type: "api_token",
      scopes: ["monitors:read"],
      expiresAt: new Date("2027-06-01T00:00:00.000Z"),
    }
    const result = validateTokenInput(
      { name: "Reader", scopes: ["monitors:read"] },
      creator,
      now
    )
    // The default 90 day window ends well before the creator, so no clamp.
    expect(result.clamped).toBe(false)
    expect(result.expiresAt).toEqual(new Date("2026-10-16T00:00:00.000Z"))
  })

  it("rejects a default when the creating credential expires within the safety margin", () => {
    const creator = {
      ...principal,
      expiresAt: new Date("2026-07-18T00:00:30.000Z"),
    }
    expect(() =>
      validateTokenInput(
        { name: "About to expire", scopes: ["monitors:read"] },
        creator,
        now
      )
    ).toThrow(/expires too soon/)
  })
})
