import { NextResponse } from "next/server"

import { authenticatedMutation, safeError } from "@/lib/onboarding/http"
import { verifyDraft } from "@/lib/onboarding/service"

export async function POST(request: Request) {
  const auth = await authenticatedMutation(request)
  if (auth.response) {
    return auth.response
  }
  try {
    return NextResponse.json(await verifyDraft(auth.session.userId))
  } catch (error) {
    return NextResponse.json(
      { error: safeError(error, "Website check failed") },
      { status: 400 }
    )
  }
}
