import "server-only"

import { isIP } from "node:net"

/** First forwarded hop only. Proxies append, so later entries are spoofable. */
export function firstForwardedIp(forwardedFor: string | null): string | null {
  return forwardedFor?.split(",")[0]?.trim() || null
}

/**
 * Client IP for stored session rows and rate-limit keys: x-real-ip is set by
 * the fronting platform and cannot be influenced by the caller, so it wins.
 * The first x-forwarded-for hop is the fallback.
 */
export function clientIpFromHeaders(headers: {
  get: (name: string) => string | null
}): string | null {
  return (
    headers.get("x-real-ip")?.trim() ||
    firstForwardedIp(headers.get("x-forwarded-for"))
  )
}

/**
 * Same source order as clientIpFromHeaders but rejects anything that is not a
 * valid IPv4 or IPv6 literal, so callers persist a clean address or nothing.
 */
export function validClientIpFromHeaders(headers: {
  get: (name: string) => string | null
}): string | null {
  const ip = clientIpFromHeaders(headers)
  return ip && isIP(ip) ? ip : null
}
