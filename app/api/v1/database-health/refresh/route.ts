import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { executeIdempotent } from "@/lib/api/idempotency"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError } from "@/lib/api/route"
import {
  DatabaseHealthUnavailableError,
  refreshDatabaseHealth,
} from "@/lib/database-health"

export async function POST(request: Request) {
  const context = await authorize(request, { scope: "config:write" })
  if (isApiResponse(context)) {
    return context
  }
  try {
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: "/api/v1/database-health/refresh",
      body: {},
      work: async () => ({
        status: 200,
        body: objectEnvelope(
          "DatabaseHealth",
          await refreshDatabaseHealth(),
          context.requestId
        ),
      }),
    })
    return apiJson(result.body, {
      status: result.status,
      headers: result.replayed ? { "Idempotency-Replayed": "true" } : undefined,
    })
  } catch (error) {
    if (error instanceof DatabaseHealthUnavailableError) {
      return apiError(
        context.requestId,
        503,
        "DATABASE_HEALTH_UNAVAILABLE",
        "Database health measurements are unavailable"
      )
    }
    return routeError(error, context.requestId)
  }
}
