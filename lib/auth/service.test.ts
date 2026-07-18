import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ReadinessReport } from "@/lib/readiness/types";

import { createOnlyAdmin, type AdminCreationStore } from "./service";

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
