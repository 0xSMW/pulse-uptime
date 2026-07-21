import {
  AccountServiceError,
  findAccountProfile,
  updateAccountProfile,
  validateProfilePatch,
} from "@/lib/api/account"
import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { serializePrincipal } from "@/lib/api/me"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError } from "@/lib/api/route"

export async function GET(request: Request) {
  const context = await authorize(request)
  if (isApiResponse(context)) {
    return context
  }
  const profile =
    context.principal.type === "human"
      ? await findAccountProfile(context.principal.id)
      : null
  return apiJson(
    objectEnvelope(
      "Me",
      serializePrincipal(context.principal, profile),
      context.requestId
    )
  )
}

export async function PATCH(request: Request) {
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
  try {
    const patch = validateProfilePatch(await request.json())
    const profile = await updateAccountProfile(context.principal.id, patch)
    return apiJson(
      objectEnvelope(
        "Me",
        serializePrincipal(context.principal, profile),
        context.requestId
      )
    )
  } catch (error) {
    if (error instanceof AccountServiceError) {
      return apiError(
        context.requestId,
        error.code === "ACCOUNT_NOT_FOUND" ? 404 : 400,
        error.code,
        error.message
      )
    }
    return routeError(error, context.requestId)
  }
}
