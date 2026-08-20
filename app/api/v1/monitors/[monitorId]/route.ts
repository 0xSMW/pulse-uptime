import { runAtomicMutation } from "@/lib/api/atomic-mutation"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { monitorError, storedMonitorError } from "@/lib/api/monitor-http"
import {
  archiveMonitor,
  requireMonitor,
  updateMonitor,
} from "@/lib/api/monitors"
import { routeError, success } from "@/lib/api/route"

interface Params {
  params: Promise<{ monitorId: string }>
}

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
    return runAtomicMutation({
      request,
      context,
      routeKey: `/api/v1/monitors/${monitorId}`,
      body,
      work: async (tx) => ({
        status: 200,
        kind: "Monitor",
        data: await updateMonitor(monitorId, body, context.principalKey, tx),
      }),
      storedError: storedMonitorError,
      mapError: monitorError,
    })
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
    return runAtomicMutation({
      request,
      context,
      routeKey: `/api/v1/monitors/${monitorId}`,
      body: {},
      work: async (tx) => ({
        status: 200,
        kind: "MonitorArchival",
        data: await archiveMonitor(monitorId, context.principalKey, tx),
      }),
      storedError: storedMonitorError,
      mapError: monitorError,
    })
  } catch (error) {
    return (
      monitorError(error, context.requestId) ??
      routeError(error, context.requestId)
    )
  }
}
