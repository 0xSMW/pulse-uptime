import { NextResponse } from "next/server"

import { enforceRateLimit, type RateLimitPolicy } from "@/lib/api/rate-limit"
import { digestBearerToken } from "@/lib/api/tokens"
import { acceptUserInvite, TeamServiceError } from "@/lib/auth/invites"
import { mutationOriginAllowed } from "@/lib/auth/origin"
import { clientIpFromHeaders } from "@/lib/auth/service"
import { sessionCookie } from "@/lib/auth/session"

/**
 * Same shape as the login limit: joins are unauthenticated and pay an Argon2
 * hash, so the source IP is throttled before any expensive work.
 */
const JOIN_RATE_LIMIT_POLICY: RateLimitPolicy = {
  routeKey: "invite-join",
  limit: 5,
  windowSeconds: 15 * 60,
}

export async function POST(request: Request) {
  if (!mutationOriginAllowed(request)) {
    return NextResponse.json({ error: "Join failed" }, { status: 403 })
  }
  const ip = clientIpFromHeaders(request.headers) ?? "unknown"
  const limit = await enforceRateLimit(
    `join-ip:${digestBearerToken(`invite-join:${ip}`).toString("hex")}`,
    JOIN_RATE_LIMIT_POLICY
  )
  if (!limit.allowed) {
    const response = NextResponse.json(
      { error: "Too many attempts. Try again soon" },
      { status: 429 }
    )
    response.headers.set(
      "Retry-After",
      String(Math.max(1, limit.retryAfterSeconds))
    )
    return response
  }
  try {
    const body = (await request.json()) as Record<string, unknown>
    const result = await acceptUserInvite({
      token: String(body.token ?? ""),
      email: String(body.email ?? ""),
      password: String(body.password ?? ""),
      passwordConfirmation: String(body.passwordConfirmation ?? ""),
      name: typeof body.name === "string" ? body.name : null,
      userAgent: request.headers.get("user-agent"),
      ipAddress: ip === "unknown" ? null : ip,
    })
    const response = NextResponse.json({ redirect: "/" })
    response.cookies.set(sessionCookie(result.sessionToken, result.expiresAt))
    return response
  } catch (error) {
    if (error instanceof TeamServiceError) {
      const status =
        error.code === "EMAIL_IN_USE"
          ? 409
          : error.code === "INVITE_INVALID"
            ? 410
            : 400
      return NextResponse.json({ error: error.message }, { status })
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Join failed" }, { status: 400 })
    }
    return NextResponse.json({ error: "Join failed" }, { status: 500 })
  }
}
