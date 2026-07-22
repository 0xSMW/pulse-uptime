import { beforeEach, describe, expect, it, vi } from "vitest"

const { afterMock } = vi.hoisted(() => ({ afterMock: vi.fn() }))

vi.mock("server-only", () => ({}))
vi.mock("next/server", () => ({ after: afterMock }))

import { authenticatePrincipal, type PrincipalStore } from "./principal"
import { digestBearerToken } from "./tokens"

beforeEach(() => {
  vi.stubEnv("API_TOKEN_HASH_KEY", "test-key-with-at-least-32-characters")
  // Outside request scope, `after()` throws and the touch runs inline.
  afterMock.mockReset().mockImplementation(() => {
    throw new Error("`after` was called outside a request scope.")
  })
})

function store(overrides: Partial<PrincipalStore> = {}): PrincipalStore {
  return {
    findApiToken: vi.fn().mockResolvedValue(null),
    findCliSession: vi.fn().mockResolvedValue(null),
    recordApiTokenUse: vi.fn().mockResolvedValue(undefined),
    recordCliSessionUse: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe("principal resolution", () => {
  it("grants every administrator scope to a valid human session", async () => {
    const principal = await authenticatePrincipal(
      new Request("https://pulse.test/api/v1/me"),
      {
        authenticateHumanSession: async () => ({
          sessionId: "ses_human",
          userId: "usr_1",
          email: "admin@example.com",
          role: "admin",
          timezone: null,
          expiresAt: new Date("2026-08-01T00:00:00Z"),
          onboardingCompletedAt: new Date("2026-07-18T00:00:00Z"),
        }),
      }
    )
    expect(principal).toMatchObject({ type: "human", id: "usr_1" })
    expect(principal?.scopes).toHaveLength(13)
    expect(principal?.scopes).toContain("reports:read")
    expect(principal?.scopes).toContain("reports:write")
    expect(principal?.scopes).toContain("dependencies:read")
    expect(principal?.scopes).toContain("dependencies:write")
    expect(principal?.scopes).toContain("users:manage")
  })

  it("grants only read scopes to a viewer session", async () => {
    const principal = await authenticatePrincipal(
      new Request("https://pulse.test/api/v1/me"),
      {
        authenticateHumanSession: async () => ({
          sessionId: "ses_viewer",
          userId: "usr_2",
          email: "viewer@example.com",
          role: "viewer",
          timezone: null,
          expiresAt: new Date("2026-08-01T00:00:00Z"),
          onboardingCompletedAt: new Date("2026-07-18T00:00:00Z"),
        }),
      }
    )
    expect(principal).toMatchObject({ type: "human", role: "viewer" })
    expect(principal?.scopes).toEqual([
      "monitors:read",
      "incidents:read",
      "config:read",
      "status:read",
      "reports:read",
      "dependencies:read",
    ])
  })

  it("verifies an API token by digest and performs a bounded touch", async () => {
    const now = new Date("2026-07-18T00:00:00Z")
    const apiToken = {
      type: "api_token" as const,
      id: "tok_1",
      name: "Deploy",
      scopes: ["status:read" as const],
      expiresAt: new Date("2026-08-01T00:00:00Z"),
    }
    const principalStore = store({
      findApiToken: vi.fn().mockResolvedValue(apiToken),
    })
    const principal = await authenticatePrincipal(
      new Request("https://pulse.test/api/v1/me", {
        headers: { Authorization: "Bearer pulse_live_secret" },
      }),
      { store: principalStore, now: () => now }
    )

    expect(principal).toEqual(apiToken)
    expect(principalStore.findApiToken).toHaveBeenCalledWith(
      digestBearerToken("pulse_live_secret"),
      now
    )
    expect(principalStore.findCliSession).not.toHaveBeenCalled()
    expect(principalStore.recordApiTokenUse).toHaveBeenCalledWith("tok_1", now)
  })

  it("resolves linked CLI metadata and rejects malformed bearer auth", async () => {
    const cliSession = {
      type: "cli_session" as const,
      id: "ses_1",
      email: "admin@example.com",
      scopes: ["monitors:read" as const],
      expiresAt: new Date("2026-08-01T00:00:00Z"),
      installation: {
        id: "ins_1",
        displayName: "Mac",
        platform: "darwin",
        architecture: "arm64",
        clientVersion: "1.0.0",
        linkedAt: new Date("2026-07-18T00:00:00Z"),
      },
    }
    const principalStore = store({
      findCliSession: vi.fn().mockResolvedValue(cliSession),
    })
    await expect(
      authenticatePrincipal(
        new Request("https://pulse.test/api/v1/me", {
          headers: { Authorization: "Bearer pulse_cli_secret" },
        }),
        { store: principalStore }
      )
    ).resolves.toEqual(cliSession)
    await expect(
      authenticatePrincipal(
        new Request("https://pulse.test/api/v1/me", {
          headers: { Authorization: "Basic secret" },
        }),
        { store: principalStore, authenticateHumanSession: vi.fn() }
      )
    ).resolves.toBeNull()
  })
})

describe("principal touch deferral", () => {
  it("resolves the API token principal before a request-scoped touch settles", async () => {
    let releaseTouch!: () => void
    let deferredCallback: (() => unknown) | undefined
    afterMock.mockImplementation((callback: () => unknown) => {
      deferredCallback = callback
    })
    const recordApiTokenUse = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseTouch = resolve
        })
    )
    const now = new Date("2026-07-18T00:00:00Z")
    const apiToken = {
      type: "api_token" as const,
      id: "tok_1",
      name: "Deploy",
      scopes: ["status:read" as const],
      expiresAt: new Date("2026-08-01T00:00:00Z"),
    }
    const principalStore = store({
      findApiToken: vi.fn().mockResolvedValue(apiToken),
      recordApiTokenUse,
    })

    const principal = await authenticatePrincipal(
      new Request("https://pulse.test/api/v1/me", {
        headers: { Authorization: "Bearer pulse_live_secret" },
      }),
      { store: principalStore, now: () => now }
    )

    // Principal resolution only registers the deferred touch callback.
    expect(principal).toEqual(apiToken)
    expect(afterMock).toHaveBeenCalledTimes(1)
    expect(recordApiTokenUse).not.toHaveBeenCalled()

    const settled = deferredCallback?.()
    expect(recordApiTokenUse).toHaveBeenCalledWith("tok_1", now)
    releaseTouch()
    await settled
  })

  it("resolves the CLI session principal before a request-scoped touch settles", async () => {
    let deferredCallback: (() => unknown) | undefined
    afterMock.mockImplementation((callback: () => unknown) => {
      deferredCallback = callback
    })
    const recordCliSessionUse = vi.fn().mockResolvedValue(undefined)
    const cliSession = {
      type: "cli_session" as const,
      id: "ses_1",
      email: "admin@example.com",
      scopes: ["monitors:read" as const],
      expiresAt: new Date("2026-08-01T00:00:00Z"),
      installation: {
        id: "ins_1",
        displayName: "Mac",
        platform: "darwin",
        architecture: "arm64",
        clientVersion: "1.0.0",
        linkedAt: new Date("2026-07-18T00:00:00Z"),
      },
    }
    const principalStore = store({
      findCliSession: vi.fn().mockResolvedValue(cliSession),
      recordCliSessionUse,
    })

    const principal = await authenticatePrincipal(
      new Request("https://pulse.test/api/v1/me", {
        headers: { Authorization: "Bearer pulse_cli_secret" },
      }),
      { store: principalStore }
    )

    expect(principal).toEqual(cliSession)
    expect(recordCliSessionUse).not.toHaveBeenCalled()

    await deferredCallback?.()
    expect(recordCliSessionUse).toHaveBeenCalledWith(
      "ses_1",
      "ins_1",
      expect.any(Date)
    )
  })

  it("swallows a deferred touch failure without surfacing it to the caller", async () => {
    let deferredCallback: (() => unknown) | undefined
    afterMock.mockImplementation((callback: () => unknown) => {
      deferredCallback = callback
    })
    const recordApiTokenUse = vi
      .fn()
      .mockRejectedValue(new Error("connection reset"))
    const apiToken = {
      type: "api_token" as const,
      id: "tok_1",
      name: "Deploy",
      scopes: ["status:read" as const],
      expiresAt: new Date("2026-08-01T00:00:00Z"),
    }
    const principalStore = store({
      findApiToken: vi.fn().mockResolvedValue(apiToken),
      recordApiTokenUse,
    })

    await expect(
      authenticatePrincipal(
        new Request("https://pulse.test/api/v1/me", {
          headers: { Authorization: "Bearer pulse_live_secret" },
        }),
        { store: principalStore }
      )
    ).resolves.toEqual(apiToken)

    await expect(deferredCallback?.()).resolves.toBeUndefined()
  })

  it("falls back to an inline, awaited touch when after() has no request scope", async () => {
    const recordApiTokenUse = vi
      .fn()
      .mockRejectedValue(new Error("connection reset"))
    const apiToken = {
      type: "api_token" as const,
      id: "tok_1",
      name: "Deploy",
      scopes: ["status:read" as const],
      expiresAt: new Date("2026-08-01T00:00:00Z"),
    }
    const principalStore = store({
      findApiToken: vi.fn().mockResolvedValue(apiToken),
      recordApiTokenUse,
    })

    await expect(
      authenticatePrincipal(
        new Request("https://pulse.test/api/v1/me", {
          headers: { Authorization: "Bearer pulse_live_secret" },
        }),
        { store: principalStore }
      )
    ).resolves.toEqual(apiToken)

    expect(recordApiTokenUse).toHaveBeenCalled()
  })
})
