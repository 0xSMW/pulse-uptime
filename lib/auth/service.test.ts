import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ReadinessReport } from "@/lib/readiness/types";

import {
  clientIpFromHeaders,
  createOnlyAdmin,
  firstForwardedIp,
  login,
  loginRateLimitKey,
  shouldRefreshLastSeen,
  type AdminCreationStore,
  type LoginDependencies,
  type LoginStore,
} from "./service";

function readiness(overrides: Partial<ReadinessReport> = {}): ReadinessReport {
  return {
    checkedAt: new Date().toISOString(), expiresAt: new Date().toISOString(),
    canContinue: true, requiresEmailAcknowledgement: false, checks: [], ...overrides,
  };
}

function fakeStore(existing = false) {
  const inserts: Parameters<AdminCreationStore["insertAdmin"]>[0][] = [];
  const store: AdminCreationStore = {
    withAdminLock: async (work) => work(store),
    hasAdmin: async () => existing,
    insertAdmin: async (input) => { inserts.push(input); },
  };
  return { store, inserts };
}

describe("administrator creation service", () => {
  it("normalizes email and atomically prepares progress and session data", async () => {
    const fake = fakeStore();
    const result = await createOnlyAdmin(
      { email: " Admin@Example.COM ", password: "correct-horse", passwordConfirmation: "correct-horse" },
      { store: fake.store, checkReadiness: async () => readiness(), now: () => new Date("2026-07-18T00:00:00Z") },
    );
    expect(result.email).toBe("admin@example.com");
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0].sessionDigest).toHaveLength(32);
  });

  it("rejects the account when core readiness is blocked", async () => {
    const fake = fakeStore();
    await expect(createOnlyAdmin(
      { email: "admin@example.com", password: "correct-horse", passwordConfirmation: "correct-horse" },
      { store: fake.store, checkReadiness: async () => readiness({ canContinue: false }) },
    )).rejects.toMatchObject({ code: "NOT_READY" });
    expect(fake.inserts).toHaveLength(0);
  });

  it("rejects a concurrent loser without exposing the administrator", async () => {
    const fake = fakeStore(true);
    await expect(createOnlyAdmin(
      { email: "second@example.com", password: "correct-horse", passwordConfirmation: "correct-horse" },
      { store: fake.store, checkReadiness: async () => readiness() },
    )).rejects.toMatchObject({ code: "ADMIN_EXISTS" });
  });
});

function persistentLimiter() {
  const buckets = new Map<string, number>();
  const seenKeys: string[] = [];
  const enforce: NonNullable<LoginDependencies["enforceLimit"]> = async (key, policy, now) => {
    seenKeys.push(key);
    const windowStart = Math.floor(now.getTime() / (policy.windowSeconds * 1_000));
    const bucket = `${key}:${policy.routeKey}:${windowStart}`;
    const count = (buckets.get(bucket) ?? 0) + 1;
    buckets.set(bucket, count);
    return {
      allowed: count <= policy.limit,
      remaining: Math.max(0, policy.limit - count),
      retryAfterSeconds: Math.max(1, Math.ceil((((windowStart + 1) * policy.windowSeconds * 1_000) - now.getTime()) / 1_000)),
    };
  };
  return { enforce, seenKeys };
}

const deterministicDigest = (value: string) => Buffer.from(value.padEnd(32, "#").slice(0, 32));

function loginStore(user: Awaited<ReturnType<LoginStore["findUser"]>> = null) {
  const sessions: Parameters<LoginStore["insertSession"]>[0][] = [];
  const store: LoginStore = {
    findUser: async () => user,
    insertSession: async (input) => { sessions.push(input); },
  };
  return { store, sessions };
}

describe("persistent login rate limiting", () => {
  it("uses digest-only email and IP bucket keys", () => {
    const emailKey = loginRateLimitKey("email", "admin@example.com", deterministicDigest);
    const ipKey = loginRateLimitKey("ip", "203.0.113.7", deterministicDigest);
    expect(emailKey).not.toContain("admin@example.com");
    expect(ipKey).not.toContain("203.0.113.7");
    expect(emailKey).toMatch(/^login-email:[0-9a-f]+$/);
    expect(ipKey).toMatch(/^login-ip:[0-9a-f]+$/);
  });

  it("persists both keys across callers and blocks the sixth attempt", async () => {
    const limiter = persistentLimiter();
    const fake = loginStore();
    const dependencies = {
      store: fake.store,
      enforceLimit: limiter.enforce,
      digestKey: deterministicDigest,
      now: () => new Date("2026-07-18T00:01:00Z"),
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(login({ email: " Admin@Example.com ", password: "wrong-password", ip: "203.0.113.7" }, { ...dependencies }))
        .rejects.toMatchObject({ code: "INVALID_LOGIN" });
    }
    await expect(login({ email: "admin@example.com", password: "wrong-password", ip: "203.0.113.7" }, { ...dependencies }))
      .rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 840 });
    expect(new Set(limiter.seenKeys)).toHaveLength(2);
    expect(limiter.seenKeys).toHaveLength(12);
  });

  it("starts a fresh distributed bucket after the fixed window", async () => {
    const limiter = persistentLimiter();
    const fake = loginStore();
    let now = new Date("2026-07-18T00:01:00Z");
    const dependencies = { store: fake.store, enforceLimit: limiter.enforce, digestKey: deterministicDigest, now: () => now };
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await login({ email: "admin@example.com", password: "wrong", ip: "203.0.113.7" }, dependencies).catch(() => undefined);
    }
    now = new Date("2026-07-18T00:15:00Z");
    await expect(login({ email: "admin@example.com", password: "wrong", ip: "203.0.113.7" }, dependencies))
      .rejects.toMatchObject({ code: "INVALID_LOGIN" });
  });

  it("creates a rotated session after an allowed successful login", async () => {
    const limiter = persistentLimiter();
    const fake = loginStore({ id: "user-1", passwordDigest: "digest", onboardingCompletedAt: null });
    const result = await login(
      { email: "admin@example.com", password: "correct", ip: "203.0.113.7", currentSessionId: "old-session" },
      {
        store: fake.store,
        enforceLimit: limiter.enforce,
        digestKey: deterministicDigest,
        verify: async () => true,
        createToken: () => ({ raw: "new-token", digest: Buffer.alloc(32, 7) }),
        now: () => new Date("2026-07-18T00:01:00Z"),
      },
    );
    expect(result.token).toBe("new-token");
    expect(fake.sessions).toHaveLength(1);
    expect(fake.sessions[0]).toMatchObject({ userId: "user-1", currentSessionId: "old-session" });
  });

  it("captures the user agent and first-hop IP on the inserted session", async () => {
    const limiter = persistentLimiter();
    const fake = loginStore({ id: "user-1", passwordDigest: "digest", onboardingCompletedAt: null });
    await login(
      {
        email: "admin@example.com",
        password: "correct",
        ip: "203.0.113.7",
        userAgent: "  Mozilla/5.0 Chrome/126.0.0.0  ",
      },
      { store: fake.store, enforceLimit: limiter.enforce, digestKey: deterministicDigest, verify: async () => true },
    );
    expect(fake.sessions[0]).toMatchObject({
      userAgent: "Mozilla/5.0 Chrome/126.0.0.0",
      ipAddress: "203.0.113.7",
    });
  });

  it("stores nulls when the agent is missing and the IP is unresolvable", async () => {
    const limiter = persistentLimiter();
    const fake = loginStore({ id: "user-1", passwordDigest: "digest", onboardingCompletedAt: null });
    await login(
      { email: "admin@example.com", password: "correct", ip: "unknown" },
      { store: fake.store, enforceLimit: limiter.enforce, digestKey: deterministicDigest, verify: async () => true },
    );
    expect(fake.sessions[0]).toMatchObject({ userAgent: null, ipAddress: null });
  });
});

describe("forwarded IP extraction", () => {
  it("takes only the first hop and trims it", () => {
    expect(firstForwardedIp("203.0.113.7, 10.0.0.1, 172.16.0.1")).toBe("203.0.113.7");
    expect(firstForwardedIp(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(firstForwardedIp(null)).toBeNull();
    expect(firstForwardedIp("")).toBeNull();
  });

  it("prefers the platform-set x-real-ip over the spoofable forwarded chain", () => {
    const headers = new Headers({
      "x-real-ip": "198.51.100.9",
      "x-forwarded-for": "203.0.113.7, 10.0.0.1",
    });
    expect(clientIpFromHeaders(headers)).toBe("198.51.100.9");
  });

  it("falls back to the first forwarded hop when x-real-ip is absent or blank", () => {
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })))
      .toBe("203.0.113.7");
    expect(clientIpFromHeaders(new Headers({ "x-real-ip": "  ", "x-forwarded-for": "203.0.113.7" })))
      .toBe("203.0.113.7");
    expect(clientIpFromHeaders(new Headers())).toBeNull();
  });
});

describe("lastSeenAt refresh throttle", () => {
  const now = new Date("2026-07-18T12:00:00Z");

  it("refreshes when the session has never been seen", () => {
    expect(shouldRefreshLastSeen(null, now)).toBe(true);
  });

  it("skips the write inside the 60-second window", () => {
    expect(shouldRefreshLastSeen(new Date("2026-07-18T11:59:30Z"), now)).toBe(false);
    expect(shouldRefreshLastSeen(new Date("2026-07-18T11:59:00Z"), now)).toBe(false);
  });

  it("refreshes once the last touch is older than 60 seconds", () => {
    expect(shouldRefreshLastSeen(new Date("2026-07-18T11:58:59.999Z"), now)).toBe(true);
  });
});
