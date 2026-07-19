import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolvePrincipal, type PrincipalStore } from "./principal";
import { digestBearerToken } from "./tokens";

beforeEach(() => {
  vi.stubEnv("API_TOKEN_HASH_KEY", "test-key-with-at-least-32-characters");
});

function store(overrides: Partial<PrincipalStore> = {}): PrincipalStore {
  return {
    findApiToken: vi.fn().mockResolvedValue(null),
    findCliSession: vi.fn().mockResolvedValue(null),
    touchApiToken: vi.fn().mockResolvedValue(undefined),
    touchCliSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("principal resolution", () => {
  it("grants every administrator scope to a valid human session", async () => {
    const principal = await resolvePrincipal(new Request("https://pulse.test/api/v1/me"), {
      getHumanSession: async () => ({
        sessionId: "ses_human",
        userId: "usr_1",
        email: "admin@example.com",
        timezone: null,
        expiresAt: new Date("2026-08-01T00:00:00Z"),
        onboardingCompletedAt: new Date("2026-07-18T00:00:00Z"),
      }),
    });
    expect(principal).toMatchObject({ type: "human", id: "usr_1" });
    expect(principal?.scopes).toHaveLength(10);
    expect(principal?.scopes).toContain("reports:read");
    expect(principal?.scopes).toContain("reports:write");
  });

  it("verifies an API token by digest and performs a bounded touch", async () => {
    const now = new Date("2026-07-18T00:00:00Z");
    const apiToken = {
      type: "api_token" as const,
      id: "tok_1",
      name: "Deploy",
      scopes: ["status:read" as const],
      expiresAt: new Date("2026-08-01T00:00:00Z"),
    };
    const principalStore = store({ findApiToken: vi.fn().mockResolvedValue(apiToken) });
    const principal = await resolvePrincipal(new Request("https://pulse.test/api/v1/me", {
      headers: { Authorization: "Bearer pulse_live_secret" },
    }), { store: principalStore, now: () => now });

    expect(principal).toEqual(apiToken);
    expect(principalStore.findApiToken).toHaveBeenCalledWith(
      digestBearerToken("pulse_live_secret"),
      now,
    );
    expect(principalStore.findCliSession).not.toHaveBeenCalled();
    expect(principalStore.touchApiToken).toHaveBeenCalledWith("tok_1", now);
  });

  it("resolves linked CLI metadata and rejects malformed bearer auth", async () => {
    const cliSession = {
      type: "cli_session" as const,
      id: "ses_1",
      email: "admin@example.com",
      scopes: ["monitors:read" as const],
      expiresAt: new Date("2026-08-01T00:00:00Z"),
      installation: {
        id: "ins_1", displayName: "Mac", platform: "darwin", architecture: "arm64",
        clientVersion: "1.0.0", linkedAt: new Date("2026-07-18T00:00:00Z"),
      },
    };
    const principalStore = store({ findCliSession: vi.fn().mockResolvedValue(cliSession) });
    await expect(resolvePrincipal(new Request("https://pulse.test/api/v1/me", {
      headers: { Authorization: "Bearer pulse_cli_secret" },
    }), { store: principalStore })).resolves.toEqual(cliSession);
    await expect(resolvePrincipal(new Request("https://pulse.test/api/v1/me", {
      headers: { Authorization: "Basic secret" },
    }), { store: principalStore, getHumanSession: vi.fn() })).resolves.toBeNull();
  });
});
