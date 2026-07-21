import { NextResponse } from "next/server"

import { authenticatedMutation } from "@/lib/onboarding/http"
import { completeOnboarding } from "@/lib/onboarding/service"

export async function POST(request: Request) {
  const auth = await authenticatedMutation(request)
  if (auth.response) {
    return auth.response
  }
  await completeOnboarding(auth.session.userId)
  return NextResponse.json({ redirect: "/" })
}
