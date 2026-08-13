import { NextResponse } from "next/server"

import { authenticatedAdminMutation, safeError } from "@/lib/onboarding/http"
import { OnboardingProbeAdmissionError } from "@/lib/onboarding/probe-admission"
import { activateFirstMonitor, OnboardingError } from "@/lib/onboarding/service"

function statusFor(error: unknown): number {
  if (error instanceof OnboardingProbeAdmissionError) {
    return 429
  }
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
  const auth = await authenticatedAdminMutation(request)
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
    const response = NextResponse.json(
      { error: safeError(error, "Could not start monitoring") },
      { status: statusFor(error) }
    )
    if (error instanceof OnboardingProbeAdmissionError) {
      response.headers.set("Retry-After", String(error.retryAfterSeconds))
    }
    return response
  }
}
