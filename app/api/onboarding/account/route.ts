import { NextResponse } from "next/server"
import { enforceRateLimit, sourceIpKey } from "@/lib/api/rate-limit"
import { mutationOriginAllowed } from "@/lib/auth/origin"
import { AuthServiceError, createOnlyAdmin } from "@/lib/auth/service"
import { sessionCookie } from "@/lib/auth/session"
import { bootstrapTokenFrom } from "@/lib/onboarding/bootstrap"
import { syncOnboardingReadiness } from "@/lib/onboarding/readiness"

// Bound unauthenticated account-creation attempts per source IP before any expensive
// work (Argon2 hashing, readiness probes) runs. Vercel overwrites X-Forwarded-For,
// so this is a stable, low-cardinality key.
const ACCOUNT_LIMIT = {
  routeKey: "onboarding-account",
  limit: 8,
  windowSeconds: 15 * 60,
}

export async function POST(request: Request) {
  if (!mutationOriginAllowed(request)) {
    return NextResponse.json(
      { error: "Request origin rejected" },
      { status: 403 }
    )
  }

  const rate = await enforceRateLimit(sourceIpKey(request), ACCOUNT_LIMIT)
  if (!rate.allowed) {
    const response = NextResponse.json(
      { error: "Too many attempts" },
      { status: 429 }
    )
    response.headers.set("Retry-After", String(rate.retryAfterSeconds))
    return response
  }

  try {
    const body = await request.json()
    const result = await createOnlyAdmin(
      { ...body, bootstrapToken: bootstrapTokenFrom(request, body) },
      { checkReadiness: syncOnboardingReadiness }
    )
    const response = NextResponse.json({ nextStep: "monitor" }, { status: 201 })
    response.cookies.set(sessionCookie(result.sessionToken, result.expiresAt))
    return response
  } catch (error) {
    if (error instanceof AuthServiceError) {
      return NextResponse.json(
        {
          error: error.message,
          redirect: error.code === "ADMIN_EXISTS" ? "/login" : undefined,
        },
        { status: statusForCode(error.code) }
      )
    }
    return NextResponse.json(
      { error: "Account creation failed" },
      { status: 500 }
    )
  }
}

function statusForCode(code: AuthServiceError["code"]): number {
  switch (code) {
    case "ADMIN_EXISTS":
      return 409
    case "BOOTSTRAP_REQUIRED":
      return 403
    default:
      return 400
  }
}
