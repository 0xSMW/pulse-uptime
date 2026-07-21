import "server-only"

import { z } from "zod"

import { apiError, apiJson, errorEnvelope, objectEnvelope } from "./envelopes"
import { executeIdempotent, type StoredResponse } from "./idempotency"
import { authorize, isApiResponse } from "./middleware"
import { MonitorApiError, setMonitorEnabled } from "./monitors"
import { routeError } from "./route"

/** Shared status map for the monitors route family. */
function monitorErrorStatus(code: MonitorApiError["code"]): number {
  return code === "MONITOR_NOT_FOUND"
    ? 404
    : code === "MONITOR_EXISTS"
      ? 409
      : code === "INVALID_REQUEST"
        ? 400
        : 503
}

/** Shared HTTP mapping for the monitors route family. */
export function monitorError(
  error: unknown,
  requestId: string
): Response | null {
  if (error instanceof MonitorApiError) {
    return apiError(
      requestId,
      monitorErrorStatus(error.code),
      error.code,
      error.message
    )
  }
  if (error instanceof z.ZodError) {
    return apiError(
      requestId,
      400,
      "INVALID_REQUEST",
      "Monitor request is invalid",
      { issues: error.issues }
    )
  }
  return null
}

// MONITOR_NOT_FOUND/MONITOR_EXISTS/INVALID_REQUEST are deterministic outcomes
// of the request, not proof it never ran, so store them as the operation's
// own completed response instead of letting them roll back the transaction.
// A stale-window retry would otherwise rerun the mutation against whatever
// config exists by then. CONFIGURATION_UNAVAILABLE/EDGE_CONFIG_UNAVAILABLE are
// transient infra failures, not request outcomes, so those still propagate and
// roll back.
export function storedMonitorError(
  error: unknown,
  requestId: string
): StoredResponse | null {
  if (!(error instanceof MonitorApiError)) {
    return null
  }
  const status =
    error.code === "MONITOR_NOT_FOUND"
      ? 404
      : error.code === "MONITOR_EXISTS"
        ? 409
        : error.code === "INVALID_REQUEST"
          ? 400
          : null
  return status
    ? { status, body: errorEnvelope(error.code, error.message, requestId) }
    : null
}

/**
 * Builds the POST handler for the pause and resume routes, which differ only
 * in the enabled flag they set and the route key they key idempotency on. The
 * setMonitorEnabled mutation and its idempotency completion commit in one
 * transaction, a MONITOR_NOT_FOUND is stored as the operation's own response,
 * and infra errors roll back and propagate.
 */
export function monitorEnabledRoute(config: {
  enabled: boolean
  routeKey: string
}) {
  return async function POST(
    request: Request,
    { params }: { params: Promise<{ monitorId: string }> }
  ) {
    const context = await authorize(request, { scope: "monitors:write" })
    if (isApiResponse(context)) {
      return context
    }
    const id = (await params).monitorId
    try {
      const result = await executeIdempotent({
        request,
        principalKey: context.principalKey,
        routeKey: `/api/v1/monitors/${id}/${config.routeKey}`,
        body: {},
        mode: "atomic",
        work: async (tx) => {
          try {
            return {
              status: 200,
              body: objectEnvelope(
                "Monitor",
                await setMonitorEnabled(
                  id,
                  config.enabled,
                  context.principalKey,
                  tx
                ),
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
        },
      })
      return apiJson(result.body, { status: result.status })
    } catch (error) {
      return (
        monitorError(error, context.requestId) ??
        routeError(error, context.requestId)
      )
    }
  }
}
