import { NextResponse } from "next/server"

import { authenticatedMutation, safeError } from "@/lib/onboarding/http"
import { activateFirstMonitor, OnboardingError } from "@/lib/onboarding/service"

function statusFor(error: unknown): number {
  if (!(error instanceof OnboardingError)) {
    return 400
  }
  if (error.code === "ACTIVATION_FAILED") {
    return 503
  }
  if (error.code === "ONBOARDING_STATE_CONFLICT") {
    return 409
  }
  return 400
}

export async function POST(request: Request) {
  const auth = await authenticatedMutation(request)
  if (auth.response) {
    return auth.response
  }
  try {
    const result = await activateFirstMonitor(
      auth.session.userId,
      await request.json()
    )
    return NextResponse.json({
      nextStep: "getting_started",
      monitor: result.monitor,
    })
  } catch (error) {
    return NextResponse.json(
      { error: safeError(error, "Could not start monitoring") },
      { status: statusFor(error) }
    )
  }
}
