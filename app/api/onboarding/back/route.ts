import { NextResponse } from "next/server"

import { authenticatedMutation, safeError } from "@/lib/onboarding/http"
import { moveBack, OnboardingError } from "@/lib/onboarding/service"

export async function POST(request: Request) {
  const auth = await authenticatedMutation(request)
  if (auth.response) {
    return auth.response
  }
  const { step } = await request.json()
  if (step !== "monitor" && step !== "verify") {
    return NextResponse.json({ error: "Invalid step" }, { status: 400 })
  }
  try {
    await moveBack(auth.session.userId, step)
    return NextResponse.json({ nextStep: step })
  } catch (error) {
    const status =
      error instanceof OnboardingError &&
      error.code === "ONBOARDING_STATE_CONFLICT"
        ? 409
        : 400
    return NextResponse.json(
      { error: safeError(error, "Could not move back") },
      { status }
    )
  }
}
