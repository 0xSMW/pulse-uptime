import { NextResponse } from "next/server";

import { createOnlyAdmin, AuthServiceError } from "@/lib/auth/service";
import { sessionCookie } from "@/lib/auth/session";
import { mutationOriginAllowed } from "@/lib/onboarding/http";
import { checkOnboardingReadiness } from "@/lib/onboarding/readiness";

export async function POST(request: Request) {
  if (!mutationOriginAllowed(request)) return NextResponse.json({ error: "Request origin rejected" }, { status: 403 });
  try {
    const body = await request.json();
    const result = await createOnlyAdmin(body, { checkReadiness: checkOnboardingReadiness });
    const response = NextResponse.json({ nextStep: "monitor" }, { status: 201 });
    response.cookies.set(sessionCookie(result.sessionToken, result.expiresAt));
    return response;
  } catch (error) {
    if (error instanceof AuthServiceError) {
      return NextResponse.json(
        { error: error.message, redirect: error.code === "ADMIN_EXISTS" ? "/login" : undefined },
        { status: error.code === "ADMIN_EXISTS" ? 409 : 400 },
      );
    }
    return NextResponse.json({ error: "Account creation failed" }, { status: 500 });
  }
}

