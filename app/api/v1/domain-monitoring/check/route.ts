import { apiError, apiJson } from "@/lib/api/envelopes"
import { executeIdempotent } from "@/lib/api/idempotency"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError, storedSuccess } from "@/lib/api/route"
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
        storedSuccess(
          "DomainMonitoring",
          await checkPorkbunConnection(),
          context.requestId
        ),
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
