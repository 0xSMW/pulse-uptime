import { NextResponse } from "next/server";

import { login } from "@/lib/auth/service";
import { getCurrentSession, sessionCookie } from "@/lib/auth/session";
import { safeReturnTo } from "@/lib/auth/return-to";
import { mutationOriginAllowed } from "@/lib/onboarding/http";

export async function POST(request: Request) {
  if (!mutationOriginAllowed(request)) return NextResponse.json({ error: "Sign in failed" }, { status: 403 });
  try {
    const body = await request.json();
    const current = await getCurrentSession();
    const result = await login({
      email: String(body.email ?? ""), password: String(body.password ?? ""),
      ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown",
      currentSessionId: current?.sessionId,
    });
    const response = NextResponse.json({
      redirect: result.onboardingComplete ? safeReturnTo(body.returnTo) : "/onboarding",
    });
    response.cookies.set(sessionCookie(result.token, result.expiresAt));
    return response;
  } catch {
    return NextResponse.json({ error: "Sign in failed" }, { status: 401 });
  }
}
