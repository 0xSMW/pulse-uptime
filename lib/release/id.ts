import "server-only";

// Immutable deployment identity for release-bound deploy proof.
// Prefer explicit PULSE_RELEASE_ID (tests/local and build-time embedding).
// Fall back to VERCEL_DEPLOYMENT_ID, the per-deployment id Vercel injects.

export const PULSE_RELEASE_ID_MAX_LENGTH = 128;

export type ReleaseIdFailureReason = "missing" | "empty" | "too_long";

export type ReleaseIdResult =
  | { ok: true; releaseId: string }
  | { ok: false; reason: ReleaseIdFailureReason };

/**
 * Validates a raw release id: nonempty after trim, at most 128 characters.
 */
export function parseReleaseId(raw: string | undefined | null): ReleaseIdResult {
  if (raw === undefined || raw === null) return { ok: false, reason: "missing" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length > PULSE_RELEASE_ID_MAX_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, releaseId: trimmed };
}

/**
 * Resolves the process release identity from environment.
 * Prefers a nonempty PULSE_RELEASE_ID over VERCEL_DEPLOYMENT_ID.
 * Empty PULSE_RELEASE_ID (next.config build-time placeholder) falls through.
 */
export function resolveReleaseIdFromEnv(
  env: Record<string, string | undefined> = process.env,
): ReleaseIdResult {
  const primary = env.PULSE_RELEASE_ID;
  if (primary !== undefined && primary.trim().length > 0) {
    return parseReleaseId(primary);
  }
  if (env.VERCEL_DEPLOYMENT_ID !== undefined) {
    return parseReleaseId(env.VERCEL_DEPLOYMENT_ID);
  }
  if (primary !== undefined) {
    return parseReleaseId(primary);
  }
  return { ok: false, reason: "missing" };
}

/**
 * True when this process is expected to have a real deployment identity.
 * Vercel production sets VERCEL_ENV=production. Plain NODE_ENV=production
 * without VERCEL_ENV also counts so a misconfigured prod host still fails closed.
 */
export function isProductionRuntime(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.VERCEL_ENV === "production") return true;
  if (env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "development") return false;
  return env.NODE_ENV === "production";
}

/** Release id when valid, otherwise null. */
export function getPulseReleaseId(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const result = resolveReleaseIdFromEnv(env);
  return result.ok ? result.releaseId : null;
}

/**
 * Returns a validated release id or throws.
 * Cron start paths use this so a missing production identity fails the run.
 */
export function requirePulseReleaseId(
  env: Record<string, string | undefined> = process.env,
): string {
  const result = resolveReleaseIdFromEnv(env);
  if (result.ok) return result.releaseId;
  throw new Error(`PULSE_RELEASE_ID is ${result.reason}`);
}
