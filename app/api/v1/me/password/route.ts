import {
  AccountServiceError,
  changeAccountPassword,
  validatePasswordChangeInput,
} from "@/lib/api/account"
import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError } from "@/lib/api/route"
import { clientIpFromHeaders } from "@/lib/auth/service"
import { expiredSessionCookie, getCurrentSession } from "@/lib/auth/session"

export async function POST(request: Request) {
  const context = await authorize(request)
  if (isApiResponse(context)) {
    return context
  }
  if (context.principal.type !== "human") {
    return apiError(
      context.requestId,
      403,
      "SESSION_REQUIRED",
      "Account settings require a dashboard session"
    )
  }
  const session = await getCurrentSession()
  if (!session) {
    return apiError(
      context.requestId,
      401,
      "AUTHENTICATION_REQUIRED",
      "Valid authentication is required"
    )
  }
  try {
    const input = validatePasswordChangeInput(await request.json())
    await changeAccountPassword({
      ...input,
      userId: context.principal.id,
      currentSessionId: session.sessionId,
      ip: clientIpFromHeaders(request.headers) ?? "unknown",
    })
    // Password rotation revokes every human session including this one. Clear
    // the cookie so the browser never keeps a valid current session token.
    const response = apiJson(
      objectEnvelope(
        "PasswordChange",
        { changed: true, reauthenticate: true },
        context.requestId
      )
    )
    response.cookies.set(expiredSessionCookie())
    return response
  } catch (error) {
    if (error instanceof AccountServiceError) {
      if (error.code === "RATE_LIMITED") {
        const response = apiError(
          context.requestId,
          429,
          error.code,
          error.message
        )
        response.headers.set(
          "Retry-After",
          String(Math.max(1, error.retryAfterSeconds ?? 1))
        )
        return response
      }
      const status =
        error.code === "INVALID_PASSWORD"
          ? 403
          : error.code === "ACCOUNT_NOT_FOUND"
            ? 404
            : error.code === "ACCOUNT_CHANGED"
              ? 409
              : 400
      return apiError(context.requestId, status, error.code, error.message)
    }
    return routeError(error, context.requestId)
  }
}
