import { revokeAllMachineCredentials } from "@/lib/api/device-authorization"
import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { executeIdempotent } from "@/lib/api/idempotency"
import { hasLiveScope } from "@/lib/api/live-authority"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError } from "@/lib/api/route"

export async function POST(request: Request) {
  const context = await authorize(request, { scope: "tokens:manage" })
  if (isApiResponse(context)) {
    return context
  }
  if (context.principal.type !== "human") {
    return apiError(
      context.requestId,
      403,
      "SESSION_REQUIRED",
      "Machine credential recovery requires a dashboard session"
    )
  }
  try {
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: "machine-credentials-revoke-all",
      body: {},
      mode: "atomic",
      work: async (tx) => {
        if (!(await hasLiveScope(tx, context.principal, "tokens:manage"))) {
          return {
            status: 403,
            body: { installations: 0, sessions: 0, tokens: 0 },
          }
        }
        return {
          status: 200,
          body: await revokeAllMachineCredentials(new Date(), tx),
        }
      },
    })
    if (result.status === 403) {
      return apiError(
        context.requestId,
        403,
        "SCOPE_DENIED",
        "The credential is no longer authorized",
        { scope: "tokens:manage" }
      )
    }
    return apiJson(
      objectEnvelope(
        "MachineCredentialRevocation",
        result.body,
        context.requestId
      )
    )
  } catch (error) {
    return routeError(error, context.requestId)
  }
}
