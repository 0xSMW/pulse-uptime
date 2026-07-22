import { describe, expect, it } from "vitest"

import { serializePrincipal } from "./me"

describe("principal serialization", () => {
  it("serializes humans without session material", () => {
    expect(
      serializePrincipal({
        type: "human",
        role: "admin",
        id: "usr_1",
        sessionId: "session_1",
        email: "admin@example.com",
        scopes: ["monitors:read"],
      })
    ).toEqual({
      principalType: "human",
      email: "admin@example.com",
      tokenId: null,
      tokenName: null,
      scopes: ["monitors:read"],
      installation: null,
      name: null,
      timezone: null,
      avatarImageId: null,
    })
  })

  it("merges the account profile into human principals", () => {
    expect(
      serializePrincipal(
        {
          type: "human",
          role: "admin",
          id: "usr_1",
          sessionId: "session_1",
          email: "admin@example.com",
          scopes: ["monitors:read"],
        },
        {
          name: "Stephen",
          timezone: "Asia/Bangkok",
          avatarImageId: null,
        }
      )
    ).toMatchObject({
      principalType: "human",
      name: "Stephen",
      timezone: "Asia/Bangkok",
      avatarImageId: null,
    })
  })

  it("serializes API tokens without email, prefix, digest, or expiry", () => {
    expect(
      serializePrincipal({
        type: "api_token",
        id: "tok_1",
        name: "Deploy agent",
        scopes: ["config:read"],
        expiresAt: new Date("2026-08-01T00:00:00Z"),
      })
    ).toEqual({
      principalType: "api_token",
      email: null,
      tokenId: "tok_1",
      tokenName: "Deploy agent",
      scopes: ["config:read"],
      installation: null,
      name: null,
      timezone: null,
      avatarImageId: null,
    })
  })

  it("includes linked installation metadata for CLI sessions", () => {
    expect(
      serializePrincipal({
        type: "cli_session",
        id: "ses_1",
        email: "admin@example.com",
        scopes: ["status:read"],
        expiresAt: new Date("2026-08-01T00:00:00Z"),
        installation: {
          id: "ins_1",
          displayName: "Stephen's Mac",
          platform: "darwin",
          architecture: "arm64",
          clientVersion: "1.0.0",
          linkedAt: new Date("2026-07-18T00:00:00Z"),
        },
      })
    ).toEqual({
      principalType: "cli_session",
      email: "admin@example.com",
      tokenId: null,
      tokenName: null,
      scopes: ["status:read"],
      installation: {
        id: "ins_1",
        name: "Stephen's Mac",
        platform: "darwin",
        arch: "arm64",
        clientVersion: "1.0.0",
        linkedAt: "2026-07-18T00:00:00.000Z",
      },
      name: null,
      timezone: null,
      avatarImageId: null,
    })
  })
})
