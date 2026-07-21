import { NextResponse } from "next/server"

import { authenticatedMutation, safeError } from "@/lib/onboarding/http"
import { OnboardingError, saveMonitorDraft } from "@/lib/onboarding/service"

export async function POST(request: Request) {
  const auth = await authenticatedMutation(request)
  if (auth.response) {
    return auth.response
  }
  try {
    const draft = await saveMonitorDraft(
      auth.session.userId,
      await request.json()
    )
    return NextResponse.json({ draft, nextStep: "verify" })
  } catch (error) {
    const status =
      error instanceof OnboardingError &&
      error.code === "ONBOARDING_STATE_CONFLICT"
        ? 409
        : 400
    return NextResponse.json(
      { error: safeError(error, "Website validation failed") },
      { status }
    )
  }
}
