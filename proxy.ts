import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

import { buildStatusPageContentSecurityPolicy } from "@/lib/status-page/csp"

export function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replaceAll("-", "")
  const policy = buildStatusPageContentSecurityPolicy(nonce)
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("Content-Security-Policy", policy)
  requestHeaders.set("x-nonce", nonce)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set("Content-Security-Policy", policy)
  return response
}

export const config = {
  matcher: ["/status/:path*"],
}
