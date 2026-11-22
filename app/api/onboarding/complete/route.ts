import { NextResponse } from "next/server"

import { authenticatedMutation, safeError } from "@/lib/onboarding/http"
import { completeOnboarding, OnboardingError } from "@/lib/onboarding/service"

export async function POST(request: Request) {
  const auth = await authenticatedMutation(request)
  if (auth.response) {
    return auth.response
  }
  try {
    await completeOnboarding(auth.session)
    return NextResponse.json({ redirect: "/" })
  } catch (error) {
    const status =
      error instanceof OnboardingError
        ? error.code === "ONBOARDING_STATE_CONFLICT"
          ? 409
          : error.code === "SESSION_REVOKED"
            ? 403
            : 400
        : 400
    return NextResponse.json(
      { error: safeError(error, "Could not finish setup") },
      { status }
    )
  }
}
