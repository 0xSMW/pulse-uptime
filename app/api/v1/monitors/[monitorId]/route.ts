import { apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { executeIdempotent } from "@/lib/api/idempotency"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { monitorError, storedMonitorError } from "@/lib/api/monitor-http"
import {
  archiveMonitor,
  requireMonitor,
  updateMonitor,
} from "@/lib/api/monitors"
import { routeError, success } from "@/lib/api/route"

type Params = { params: Promise<{ monitorId: string }> }

export async function GET(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "monitors:read" })
  if (isApiResponse(context)) {
    return context
  }
  try {
    return success(
      "Monitor",
      await requireMonitor((await params).monitorId),
      context.requestId
    )
  } catch (error) {
    return (
      monitorError(error, context.requestId) ??
      routeError(error, context.requestId)
    )
  }
}

export async function PATCH(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "monitors:write" })
  if (isApiResponse(context)) {
    return context
  }
  const monitorId = (await params).monitorId
  try {
    const body = await request.json()
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: `/api/v1/monitors/${monitorId}`,
      body,
      work: async ({ transaction }) =>
        transaction(async (tx) => {
          try {
            return {
              status: 200,
              body: objectEnvelope(
                "Monitor",
                await updateMonitor(monitorId, body, context.principalKey, tx),
                context.requestId
              ),
            }
          } catch (error) {
            const stored = storedMonitorError(error, context.requestId)
            if (stored) {
              return stored
            }
            throw error
          }
        }),
    })
    return apiJson(result.body, { status: result.status })
  } catch (error) {
    return (
      monitorError(error, context.requestId) ??
      routeError(error, context.requestId)
    )
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "monitors:write" })
  if (isApiResponse(context)) {
    return context
  }
  const monitorId = (await params).monitorId
  try {
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: `/api/v1/monitors/${monitorId}`,
      body: {},
      work: async ({ transaction }) =>
        transaction(async (tx) => {
          try {
            return {
              status: 200,
              body: objectEnvelope(
                "MonitorArchival",
                await archiveMonitor(monitorId, context.principalKey, tx),
                context.requestId
              ),
            }
          } catch (error) {
            const stored = storedMonitorError(error, context.requestId)
            if (stored) {
              return stored
            }
            throw error
          }
        }),
    })
    return apiJson(result.body, { status: result.status })
  } catch (error) {
    return (
      monitorError(error, context.requestId) ??
      routeError(error, context.requestId)
    )
  }
}
