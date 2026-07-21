import { NextResponse } from "next/server"
import { mutationOriginAllowed } from "@/lib/auth/origin"
import { revokeSession } from "@/lib/auth/service"
import {
  authenticateCurrentSession,
  expiredSessionCookie,
} from "@/lib/auth/session"

export async function POST(request: Request) {
  if (!mutationOriginAllowed(request)) {
    return NextResponse.json(
      { error: "Request origin rejected" },
      { status: 403 }
    )
  }
  const session = await authenticateCurrentSession()
  if (session) {
    await revokeSession(session.sessionId)
  }
  const response = NextResponse.json({ redirect: "/login" })
  response.cookies.set(expiredSessionCookie())
  return response
}
