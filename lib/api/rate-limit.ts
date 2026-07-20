import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { apiRateLimitBuckets } from "@/lib/db/schema";
import { clientIpFromHeaders } from "@/lib/net/client-ip";

import { digestBearerToken } from "./tokens";

export type RateLimitPolicy = {
  routeKey: string;
  limit: number;
  windowSeconds: number;
  resourceKey?: string;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export async function enforceRateLimit(
  principalKey: string,
  policy: RateLimitPolicy,
  now = new Date(),
): Promise<RateLimitResult> {
  const windowMs = policy.windowSeconds * 1_000;
  const windowStartedAt = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const expiresAt = new Date(windowStartedAt.getTime() + windowMs * 2);
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
    .returning({ requestCount: apiRateLimitBuckets.requestCount });
  const count = bucket?.requestCount ?? policy.limit + 1;
  return {
    allowed: count <= policy.limit,
    remaining: Math.max(0, policy.limit - count),
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((windowStartedAt.getTime() + windowMs - now.getTime()) / 1_000),
    ),
  };
}

export function sourceIpKey(request: Request): string {
  const ip = clientIpFromHeaders(request.headers) ?? "unknown";
  return `ip:${digestBearerToken(`source-ip:${ip}`).toString("hex")}`;
}

export const AUTHENTICATED_READ_LIMIT: Omit<RateLimitPolicy, "routeKey"> = {
  limit: 600,
  windowSeconds: 300,
};

export const AUTHENTICATED_MUTATION_LIMIT: Omit<RateLimitPolicy, "routeKey"> = {
  limit: 120,
  windowSeconds: 300,
};
