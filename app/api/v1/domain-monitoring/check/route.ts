import { apiError, apiJson, errorEnvelope } from "@/lib/api/envelopes"
import { executeIdempotent } from "@/lib/api/idempotency"
import { hasLiveScope } from "@/lib/api/live-authority"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError, storedSuccess } from "@/lib/api/route"
import { db } from "@/lib/db/client"
import {
  checkPorkbunConnection,
  DomainMonitoringError,
} from "@/lib/domain-health/porkbun-settings"

export async function POST(request: Request) {
  const context = await authorize(request, { scope: "config:write" })
  if (isApiResponse(context)) {
    return context
  }
  try {
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: "/api/v1/domain-monitoring/check",
      body: {},
      mode: "conservative",
      work: async () =>
        await db.transaction(async (tx) => {
          if (!(await hasLiveScope(tx, context.principal, "config:write"))) {
            return {
              status: 403,
              body: errorEnvelope(
                "AUTHORIZATION_REVOKED",
                "Configuration write authorization is no longer active",
                context.requestId
              ),
            }
          }
          try {
            return storedSuccess(
              "DomainMonitoring",
              await checkPorkbunConnection({ handle: tx }),
              context.requestId
            )
          } catch (error) {
            if (error instanceof DomainMonitoringError) {
              return {
                status: 503,
                body: errorEnvelope(
                  error.code,
                  error.message,
                  context.requestId
                ),
              }
            }
            throw error
          }
        }),
    })
    return apiJson(result.body, {
      status: result.status,
      headers: result.replayed ? { "Idempotency-Replayed": "true" } : undefined,
    })
  } catch (error) {
    if (error instanceof DomainMonitoringError) {
      return apiError(context.requestId, 503, error.code, error.message)
    }
    return routeError(error, context.requestId)
  }
}
