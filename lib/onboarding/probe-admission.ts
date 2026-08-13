import "server-only"

import { createHash, randomUUID } from "node:crypto"

import {
  enforceRateLimit,
  type RateLimitPolicy,
  type RateLimitResult,
} from "@/lib/api/rate-limit"
import { queryExecutor } from "@/lib/db/query-executor"
import type { LeaseStore } from "@/lib/scheduler/lease"
import { createSqlLeaseStore } from "@/lib/scheduler/sql"

const USER_PROBE_LIMIT: RateLimitPolicy = {
  routeKey: "onboarding-probe-user",
  limit: 10,
  windowSeconds: 60,
}

const TARGET_PROBE_LIMIT: Omit<RateLimitPolicy, "resourceKey"> = {
  routeKey: "onboarding-probe-target",
  limit: 4,
  windowSeconds: 60,
}

const MAX_CONCURRENT_PROBES_PER_USER = 2
const PROBE_LEASE_DURATION_MS = 90_000
const defaultLeaseStore = createSqlLeaseStore(queryExecutor)

export class OnboardingProbeAdmissionError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Try again shortly")
    this.name = "OnboardingProbeAdmissionError"
  }
}

type RateLimiter = (
  principalKey: string,
  policy: RateLimitPolicy
) => Promise<RateLimitResult>

interface ProbeAdmissionOptions<T> {
  userId: string
  target: string
  work: () => Promise<T>
  enforce?: RateLimiter
  leases?: LeaseStore
  createOwnerId?: () => string
}

function targetKey(target: string): string {
  const normalizedOrigin = new URL(target).origin
  return createHash("sha256")
    .update(`onboarding-target:${normalizedOrigin}`)
    .digest("hex")
}

function userLeasePrefix(userId: string): string {
  const userHash = createHash("sha256")
    .update(`onboarding-user:${userId}`)
    .digest("hex")
  return `onboarding-probe:${userHash}`
}

function requireAllowed(result: RateLimitResult): void {
  if (!result.allowed) {
    throw new OnboardingProbeAdmissionError(result.retryAfterSeconds)
  }
}

async function acquireProbeLease(
  leases: LeaseStore,
  userId: string,
  ownerId: string
): Promise<string | null> {
  const prefix = userLeasePrefix(userId)
  for (let slot = 0; slot < MAX_CONCURRENT_PROBES_PER_USER; slot += 1) {
    const name = `${prefix}:${slot}`
    if (await leases.acquire(name, ownerId, PROBE_LEASE_DURATION_MS)) {
      return name
    }
  }
  return null
}

function logLeaseReleaseFailed(
  leaseName: string,
  ownerId: string,
  error: unknown
): void {
  console.warn(
    JSON.stringify({
      event: "onboarding.probe_lease_release_failed",
      leaseName,
      ownerId,
      error: error instanceof Error ? error.message : String(error),
    })
  )
}

/** Bounds authenticated onboarding HTTP probes before network work starts. */
export async function runWithOnboardingProbeAdmission<T>({
  userId,
  target,
  work,
  enforce = enforceRateLimit,
  leases = defaultLeaseStore,
  createOwnerId = randomUUID,
}: ProbeAdmissionOptions<T>): Promise<T> {
  requireAllowed(await enforce(`user:${userId}`, USER_PROBE_LIMIT))
  requireAllowed(
    await enforce("resource:onboarding-target", {
      ...TARGET_PROBE_LIMIT,
      resourceKey: targetKey(target),
    })
  )

  const ownerId = createOwnerId()
  const leaseName = await acquireProbeLease(leases, userId, ownerId)
  if (!leaseName) {
    throw new OnboardingProbeAdmissionError(1)
  }

  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    outcome = { ok: true, value: await work() }
  } catch (error) {
    outcome = { ok: false, error }
  }

  try {
    await leases.release(leaseName, ownerId)
  } catch (error) {
    logLeaseReleaseFailed(leaseName, ownerId, error)
  }

  if (!outcome.ok) {
    throw outcome.error
  }
  return outcome.value
}
