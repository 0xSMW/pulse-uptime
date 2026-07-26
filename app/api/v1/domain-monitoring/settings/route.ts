import { z } from "zod"

import { apiError, apiJson } from "@/lib/api/envelopes"
import { executeIdempotent } from "@/lib/api/idempotency"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError, storedSuccess } from "@/lib/api/route"
import {
  DomainMonitoringError,
  updateDomainMonitoringSettings,
} from "@/lib/domain-health/porkbun-settings"

const requestSchema = z.object({ expiryAlertsEnabled: z.boolean() }).strict()

export async function PATCH(request: Request) {
  const context = await authorize(request, { scope: "config:write" })
  if (isApiResponse(context)) {
    return context
  }
  try {
    const parsed = requestSchema.safeParse(await request.json())
    if (!parsed.success) {
      return apiError(
        context.requestId,
        400,
        "INVALID_REQUEST",
        "expiryAlertsEnabled must be a boolean"
      )
    }
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: "/api/v1/domain-monitoring/settings",
      body: parsed.data,
      mode: "atomic",
      work: async (handle) =>
        storedSuccess(
          "DomainMonitoring",
          await updateDomainMonitoringSettings(parsed.data, { handle }),
          context.requestId
        ),
    })
    return apiJson(result.body, {
      status: result.status,
      headers: result.replayed ? { "Idempotency-Replayed": "true" } : undefined,
    })
  } catch (error) {
    if (error instanceof DomainMonitoringError) {
      return apiError(context.requestId, 409, error.code, error.message)
    }
    return routeError(error, context.requestId)
  }
}
