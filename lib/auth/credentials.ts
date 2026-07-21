import { createHash, randomBytes } from "node:crypto"
import argon2 from "argon2"

export const SESSION_COOKIE_NAME = "__Host-pulse_session"
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function validatePassword(password: string): string | null {
  if (password.length < 12) {
    return "Use at least 12 characters"
  }
  if (password.length > 128) {
    return "Use no more than 128 characters"
  }
  return null
}

export async function hashPassword(password: string): Promise<string> {
  const error = validatePassword(password)
  if (error) {
    throw new Error(error)
  }

  return argon2.hash(password, {
    type: argon2.argon2id,
  })
}

export async function verifyPassword(
  digest: string,
  password: string
): Promise<boolean> {
  try {
    return await argon2.verify(digest, password)
  } catch {
    return false
  }
}

export function createSessionToken(): { raw: string; digest: Buffer } {
  const raw = randomBytes(32).toString("base64url")
  return { raw, digest: digestSessionToken(raw) }
}

export function digestSessionToken(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest()
}

export function sessionExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + SESSION_DURATION_MS)
}
