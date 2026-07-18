import { NextResponse } from "next/server";

import { revokeSession } from "@/lib/auth/service";
import { expiredSessionCookie, getCurrentSession } from "@/lib/auth/session";
import { mutationOriginAllowed } from "@/lib/onboarding/http";

export async function POST(request: Request) {
  if (!mutationOriginAllowed(request)) return NextResponse.json({ error: "Request origin rejected" }, { status: 403 });
  const session = await getCurrentSession();
  if (session) await revokeSession(session.sessionId);
  const response = NextResponse.json({ redirect: "/login" });
  response.cookies.set(expiredSessionCookie());
  return response;
}

