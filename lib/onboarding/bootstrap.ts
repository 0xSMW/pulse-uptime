import "server-only"

import { createHash, timingSafeEqual } from "node:crypto"

const BOOTSTRAP_TOKEN_HEADER = "x-pulse-bootstrap-token"

/**
 * The first-admin claim is gated on a one-time, high-entropy bootstrap credential
 * that only the operator who deployed the instance can know: it is supplied out of
 * band as the PULSE_BOOTSTRAP_TOKEN environment variable. Without a configured token
 * the install cannot be claimed at all (fail closed), which removes the public
 * account-takeover path — a direct HTTP client can no longer become the sole
 * administrator by merely presenting the expected Origin.
 */
export function verifyBootstrapToken(
  provided: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const expected = env.PULSE_BOOTSTRAP_TOKEN
  // Fail closed: an unconfigured or too-weak token can never be satisfied.
  if (typeof expected !== "string" || expected.length < 16) {
    return false
  }
  if (typeof provided !== "string" || provided.length === 0) {
    return false
  }
  // Compare fixed-length digests so the comparison neither leaks length nor
  // short-circuits on the first differing byte.
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest()
  const providedDigest = createHash("sha256").update(provided, "utf8").digest()
  return timingSafeEqual(expectedDigest, providedDigest)
}

/** Reads the bootstrap token from the dedicated header or the request body. */
export function bootstrapTokenFrom(
  request: Request,
  body: unknown
): string | undefined {
  const header = request.headers.get(BOOTSTRAP_TOKEN_HEADER)
  if (typeof header === "string" && header.trim()) {
    return header.trim()
  }
  if (body && typeof body === "object" && "bootstrapToken" in body) {
    const value = (body as { bootstrapToken?: unknown }).bootstrapToken
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }
}
