import { NextResponse } from "next/server"

import { authenticatedAdminMutation, safeError } from "@/lib/onboarding/http"
import { OnboardingProbeAdmissionError } from "@/lib/onboarding/probe-admission"
import { verifyDraft } from "@/lib/onboarding/service"

export async function POST(request: Request) {
  const auth = await authenticatedAdminMutation(request)
  if (auth.response) {
    return auth.response
  }
  try {
    return NextResponse.json(await verifyDraft(auth.session.userId))
  } catch (error) {
    const response = NextResponse.json(
      { error: safeError(error, "Website check failed") },
      { status: error instanceof OnboardingProbeAdmissionError ? 429 : 400 }
    )
    if (error instanceof OnboardingProbeAdmissionError) {
      response.headers.set("Retry-After", String(error.retryAfterSeconds))
    }
    return response
  }
}
