import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  digestSessionToken,
  hashPassword,
  normalizeEmail,
  sessionExpiresAt,
  validatePassword,
  verifyPassword,
} from "./credentials";
import { isAllowedOrigin } from "./origin";

describe("credential primitives", () => {
  it("normalizes administrator email", () => {
    expect(normalizeEmail("  Admin@Example.COM ")).toBe("admin@example.com");
  });

  it("enforces the documented password length", () => {
    expect(validatePassword("short")).toBe("Use at least 12 characters");
    expect(validatePassword("correct-horse")).toBeNull();
    expect(validatePassword("a".repeat(129))).toBe(
      "Use no more than 128 characters",
    );
  });

  it("stores Argon2id digests and verifies them", async () => {
    const digest = await hashPassword("correct-horse-battery-staple");
    expect(digest).toMatch(/^\$argon2id\$/);
    await expect(
      verifyPassword(digest, "correct-horse-battery-staple"),
    ).resolves.toBe(true);
    await expect(verifyPassword(digest, "wrong-password-value")).resolves.toBe(
      false,
    );
  });

  it("creates 256-bit opaque tokens and stable digests", () => {
    const first = createSessionToken();
    const second = createSessionToken();
    expect(Buffer.from(first.raw, "base64url")).toHaveLength(32);
    expect(first.digest.equals(digestSessionToken(first.raw))).toBe(true);
    expect(first.raw).not.toBe(second.raw);
  });

  it("uses a thirty-day session lifetime", () => {
    const now = new Date("2026-07-18T00:00:00.000Z");
    expect(sessionExpiresAt(now).toISOString()).toBe(
      "2026-08-17T00:00:00.000Z",
    );
  });
});

describe("origin checks", () => {
  it("accepts only the configured origin", () => {
    expect(
      isAllowedOrigin("https://pulse.example.com", "https://pulse.example.com"),
    ).toBe(true);
    expect(
      isAllowedOrigin("https://evil.example", "https://pulse.example.com"),
    ).toBe(false);
    expect(isAllowedOrigin(null, "https://pulse.example.com")).toBe(false);
  });
});
