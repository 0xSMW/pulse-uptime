import { revokeAllMachineCredentials } from "@/lib/api/device-authorization"
import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { executeIdempotent } from "@/lib/api/idempotency"
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
      work: async (tx) => ({
        status: 200,
        body: await revokeAllMachineCredentials(new Date(), tx),
      }),
    })
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
