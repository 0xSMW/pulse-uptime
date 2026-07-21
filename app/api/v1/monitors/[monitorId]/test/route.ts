import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { executeIdempotent } from "@/lib/api/idempotency"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { MonitorApiError, testMonitor } from "@/lib/api/monitors"
import { enforceRateLimit } from "@/lib/api/rate-limit"
import { routeError } from "@/lib/api/route"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ monitorId: string }> }
) {
  const context = await authorize(request, {
    scope: "monitors:write",
    rateLimit: {
      routeKey: "monitor-test-principal",
      limit: 20,
      windowSeconds: 60,
    },
  })
  if (isApiResponse(context)) {
    return context
  }
  const id = (await params).monitorId
  const monitorRate = await enforceRateLimit("resource:monitor", {
    routeKey: "monitor-test-monitor",
    resourceKey: id,
    limit: 5,
    windowSeconds: 60,
  })
  if (!monitorRate.allowed) {
    const response = apiError(
      context.requestId,
      429,
      "RATE_LIMITED",
      "Too many requests"
    )
    response.headers.set("Retry-After", String(monitorRate.retryAfterSeconds))
    return response
  }
  try {
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: `/api/v1/monitors/${id}/test`,
      body: {},
      work: async () => ({
        status: 200,
        body: objectEnvelope(
          "MonitorTest",
          await testMonitor(id),
          context.requestId
        ),
      }),
    })
    return apiJson(result.body, { status: result.status })
  } catch (error) {
    if (error instanceof MonitorApiError) {
      return apiError(
        context.requestId,
        error.code === "MONITOR_NOT_FOUND" ? 404 : 503,
        error.code,
        error.message
      )
    }
    return routeError(error, context.requestId)
  }
}
