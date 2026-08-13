import "server-only"

import { clientIpFromHeaders } from "@/lib/net/client-ip"

export interface LocalAdmissionPolicy {
  limit: number
  maxEntries: number
  windowMs: number
}

export interface LocalAdmissionResult {
  allowed: boolean
  retryAfterSeconds: number
}

interface AdmissionBucket {
  count: number
  expiresAtMs: number
}

/**
 * Cheap, bounded admission control for public routes that must reject floods
 * before a persistent rate limiter or any other database lookup can run.
 */
export function createLocalAdmissionControl(policy: LocalAdmissionPolicy) {
  const buckets = new Map<string, AdmissionBucket>()

  return {
    check(key: string, nowMs = Date.now()): LocalAdmissionResult {
      const existing = buckets.get(key)
      if (existing && existing.expiresAtMs > nowMs) {
        existing.count += 1
        return {
          allowed: existing.count <= policy.limit,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((existing.expiresAtMs - nowMs) / 1000)
          ),
        }
      }

      if (existing) {
        buckets.delete(key)
      }
      if (buckets.size >= policy.maxEntries) {
        const oldestKey = buckets.keys().next().value
        if (oldestKey !== undefined) {
          buckets.delete(oldestKey)
        }
      }

      buckets.set(key, {
        count: 1,
        expiresAtMs: nowMs + policy.windowMs,
      })
      return {
        allowed: true,
        retryAfterSeconds: Math.max(1, Math.ceil(policy.windowMs / 1000)),
      }
    },
    reset(): void {
      buckets.clear()
    },
  }
}

export function localAdmissionSourceKey(request: Request): string {
  return clientIpFromHeaders(request.headers) ?? "unknown"
}
