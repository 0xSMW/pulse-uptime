import {
  AccountServiceError,
  revokeOtherAccountSessions,
} from "@/lib/api/account"
import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError } from "@/lib/api/route"
import { authenticateCurrentSession } from "@/lib/auth/session"

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
  const session = await authenticateCurrentSession()
  if (!session) {
    return apiError(
      context.requestId,
      401,
      "AUTHENTICATION_REQUIRED",
      "Valid authentication is required"
    )
  }
  try {
    const result = await revokeOtherAccountSessions({
      userId: context.principal.id,
      currentSessionId: session.sessionId,
    })
    return apiJson(
      objectEnvelope(
        "SessionRevocation",
        { revokedCount: result.revokedCount },
        context.requestId
      )
    )
  } catch (error) {
    if (error instanceof AccountServiceError) {
      return apiError(context.requestId, 400, error.code, error.message)
    }
    return routeError(error, context.requestId)
  }
}
