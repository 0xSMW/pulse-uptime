import { NextResponse } from "next/server"

import { authenticatedMutation, safeError } from "@/lib/onboarding/http"
import { saveMonitorDraft } from "@/lib/onboarding/service"

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
    return NextResponse.json(
      { error: safeError(error, "Website validation failed") },
      { status: 400 }
    )
  }
}
