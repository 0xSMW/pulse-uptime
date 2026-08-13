import "server-only"

import { and, eq, sql } from "drizzle-orm"

import { db } from "@/lib/db/client"
import { apiRateLimitBuckets } from "@/lib/db/schema"
import { clientIpFromHeaders } from "@/lib/net/client-ip"

import { digestBearerToken } from "./tokens"

export interface RateLimitPolicy {
  routeKey: string
  limit: number
  windowSeconds: number
  resourceKey?: string
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

function rateLimitWindow(policy: RateLimitPolicy, now: Date) {
  const windowMs = policy.windowSeconds * 1000
  const windowStartedAt = new Date(
    Math.floor(now.getTime() / windowMs) * windowMs
  )
  return {
    windowMs,
    windowStartedAt,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((windowStartedAt.getTime() + windowMs - now.getTime()) / 1000)
    ),
  }
}

/** Releases one admitted request without allowing the bucket below zero. */
export async function releaseRateLimit(
  principalKey: string,
  policy: RateLimitPolicy,
  now = new Date()
): Promise<void> {
  const { windowStartedAt } = rateLimitWindow(policy, now)
  await db
    .update(apiRateLimitBuckets)
    .set({
      requestCount: sql`greatest(${apiRateLimitBuckets.requestCount} - 1, 0)`,
    })
    .where(
      and(
        eq(apiRateLimitBuckets.principalKey, principalKey),
        eq(apiRateLimitBuckets.routeKey, policy.routeKey),
        eq(apiRateLimitBuckets.resourceKey, policy.resourceKey ?? ""),
        eq(apiRateLimitBuckets.windowStartedAt, windowStartedAt)
      )
    )
}

export async function enforceRateLimit(
  principalKey: string,
  policy: RateLimitPolicy,
  now = new Date()
): Promise<RateLimitResult> {
  const { retryAfterSeconds, windowMs, windowStartedAt } = rateLimitWindow(
    policy,
    now
  )
  const expiresAt = new Date(windowStartedAt.getTime() + windowMs * 2)
  const [bucket] = await db
    .insert(apiRateLimitBuckets)
    .values({
      principalKey,
      routeKey: policy.routeKey,
      resourceKey: policy.resourceKey ?? "",
      windowStartedAt,
      windowSeconds: policy.windowSeconds,
      requestCount: 1,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [
        apiRateLimitBuckets.principalKey,
        apiRateLimitBuckets.routeKey,
        apiRateLimitBuckets.resourceKey,
        apiRateLimitBuckets.windowStartedAt,
      ],
      set: {
        requestCount: sql`${apiRateLimitBuckets.requestCount} + 1`,
        expiresAt,
      },
    })
    .returning({ requestCount: apiRateLimitBuckets.requestCount })
  const count = bucket?.requestCount ?? policy.limit + 1
  return {
    allowed: count <= policy.limit,
    remaining: Math.max(0, policy.limit - count),
    retryAfterSeconds,
  }
}

export function sourceIpKey(request: Request): string {
  const ip = clientIpFromHeaders(request.headers) ?? "unknown"
  return `ip:${digestBearerToken(`source-ip:${ip}`).toString("hex")}`
}

export const AUTHENTICATED_READ_LIMIT: Omit<RateLimitPolicy, "routeKey"> = {
  limit: 600,
  windowSeconds: 300,
}

export const AUTHENTICATED_MUTATION_LIMIT: Omit<RateLimitPolicy, "routeKey"> = {
  limit: 120,
  windowSeconds: 300,
}
