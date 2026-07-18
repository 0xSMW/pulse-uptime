import "server-only";

import { NextResponse } from "next/server";

import { isAllowedOrigin } from "@/lib/auth/origin";
import { getCurrentSession } from "@/lib/auth/session";

export function mutationOriginAllowed(request: Request) {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  const appUrl = configured || new URL(request.url).origin;
  return isAllowedOrigin(request.headers.get("origin"), appUrl);
}

export async function authenticatedMutation(request: Request) {
  if (!mutationOriginAllowed(request)) {
    return { session: null, response: NextResponse.json({ error: "Request origin rejected" }, { status: 403 }) };
  }
  const session = await getCurrentSession();
  if (!session) return { session: null, response: NextResponse.json({ error: "Sign in required" }, { status: 401 }) };
  return { session, response: null };
}

export function safeError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

