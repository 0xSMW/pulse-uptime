import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/db/client", () => ({ db: {} }))

import {
  decryptPorkbunWebhookSecret,
  encryptPorkbunWebhookSecret,
  readPorkbunWebhookSigningSecret,
  upsertPorkbunIntegration,
} from "./store"

const key = "test-key-with-at-least-32-characters"

describe("Porkbun webhook secret encryption", () => {
  it("round-trips a versioned AES-GCM ciphertext", () => {
    const encrypted = encryptPorkbunWebhookSecret("webhook-signing-secret", key)

    expect(encrypted).toMatch(
      /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/
    )
    expect(encrypted).not.toContain("webhook-signing-secret")
    expect(decryptPorkbunWebhookSecret(encrypted, key)).toBe(
      "webhook-signing-secret"
    )
  })

  it("rejects malformed and tampered ciphertext", () => {
    const encrypted = encryptPorkbunWebhookSecret("webhook-signing-secret", key)
    const [version, iv, tag, ciphertext] = encrypted.split(":")
    const tampered = [
      version,
      iv,
      `${tag!.startsWith("A") ? "B" : "A"}${tag!.slice(1)}`,
      ciphertext,
    ].join(":")

    expect(() => decryptPorkbunWebhookSecret("v2:bad", key)).toThrow(
      "Invalid Porkbun webhook secret ciphertext"
    )
    expect(() => decryptPorkbunWebhookSecret(tampered, key)).toThrow(
      "Invalid Porkbun webhook secret ciphertext"
    )
  })

  it("requires a sufficiently strong API token hash key", () => {
    expect(() => encryptPorkbunWebhookSecret("secret", "short")).toThrow(
      "API_TOKEN_HASH_KEY must contain at least 32 characters"
    )
  })

  it("requires webhook credentials to be updated as a pair", async () => {
    await expect(
      upsertPorkbunIntegration({ webhookId: 123 }, { handle: {} as never })
    ).rejects.toThrow("Porkbun webhook ID and secret must be updated together")
  })

  it("observes committed rotation independently across warm instances", async () => {
    vi.stubEnv("API_TOKEN_HASH_KEY", key)
    let encrypted = encryptPorkbunWebhookSecret("first-secret", key)
    const handle = () =>
      ({
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => [{ encrypted }] }),
          }),
        }),
      }) as never
    const firstInstance = handle()
    const secondInstance = handle()

    expect(await readPorkbunWebhookSigningSecret(firstInstance)).toBe(
      "first-secret"
    )
    expect(await readPorkbunWebhookSigningSecret(secondInstance)).toBe(
      "first-secret"
    )

    encrypted = encryptPorkbunWebhookSecret("next-secret", key)
    expect(await readPorkbunWebhookSigningSecret(firstInstance)).toBe(
      "next-secret"
    )
    expect(await readPorkbunWebhookSigningSecret(secondInstance)).toBe(
      "next-secret"
    )
  })
})
