import { NextResponse } from "next/server"
import { mutationOriginAllowed } from "@/lib/auth/origin"
import { safeReturnTo } from "@/lib/auth/return-to"
import {
  AuthServiceError,
  clientIpFromHeaders,
  login,
} from "@/lib/auth/service"
import { getCurrentSession, sessionCookie } from "@/lib/auth/session"

export async function POST(request: Request) {
  if (!mutationOriginAllowed(request)) {
    return NextResponse.json({ error: "Sign in failed" }, { status: 403 })
  }
  try {
    const body = await request.json()
    const current = await getCurrentSession()
    const result = await login({
      email: String(body.email ?? ""),
      password: String(body.password ?? ""),
      ip: clientIpFromHeaders(request.headers) ?? "unknown",
      userAgent: request.headers.get("user-agent"),
      currentSessionId: current?.sessionId,
    })
    const response = NextResponse.json({
      redirect: result.onboardingComplete
        ? safeReturnTo(body.returnTo)
        : "/onboarding",
    })
    response.cookies.set(sessionCookie(result.token, result.expiresAt))
    return response
  } catch (error) {
    return loginFailure(error)
  }
}

export function loginFailure(error: unknown) {
  if (error instanceof AuthServiceError && error.code === "RATE_LIMITED") {
    const response = NextResponse.json(
      { error: "Sign in failed" },
      { status: 429 }
    )
    response.headers.set(
      "Retry-After",
      String(Math.max(1, error.retryAfterSeconds ?? 1))
    )
    return response
  }
  return NextResponse.json({ error: "Sign in failed" }, { status: 401 })
}
