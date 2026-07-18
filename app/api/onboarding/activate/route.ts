import { NextResponse } from "next/server";

import { authenticatedMutation, safeError } from "@/lib/onboarding/http";
import { activateFirstMonitor, OnboardingError } from "@/lib/onboarding/service";

export async function POST(request: Request) {
  const auth = await authenticatedMutation(request);
  if (auth.response) return auth.response;
  try {
    const result = await activateFirstMonitor(auth.session.userId, await request.json());
    return NextResponse.json({ nextStep: "getting_started", monitor: result.monitor });
  } catch (error) {
    const status = error instanceof OnboardingError && error.code === "ACTIVATION_FAILED" ? 503 : 400;
    return NextResponse.json({ error: safeError(error, "Could not start monitoring") }, { status });
  }
}

