import { NextResponse } from "next/server";

import { authenticatedMutation } from "@/lib/onboarding/http";
import { moveBack } from "@/lib/onboarding/service";

export async function POST(request: Request) {
  const auth = await authenticatedMutation(request);
  if (auth.response) return auth.response;
  const { step } = await request.json();
  if (step !== "monitor" && step !== "verify") return NextResponse.json({ error: "Invalid step" }, { status: 400 });
  await moveBack(auth.session.userId, step);
  return NextResponse.json({ nextStep: step });
}

