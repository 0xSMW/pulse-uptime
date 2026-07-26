import { z } from "zod"

import { apiError, apiJson } from "@/lib/api/envelopes"
import { executeIdempotent } from "@/lib/api/idempotency"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError, storedSuccess } from "@/lib/api/route"
import {
  DomainMonitoringError,
  managePorkbunWebhook,
} from "@/lib/domain-health/porkbun-settings"

const requestSchema = z
  .object({ action: z.enum(["enable", "disable", "test"]) })
  .strict()

export async function POST(request: Request) {
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
        "action must be enable, disable, or test"
      )
    }
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: "/api/v1/domain-monitoring/webhook",
      body: parsed.data,
      mode: "conservative",
      work: async () =>
        storedSuccess(
          "DomainMonitoring",
          await managePorkbunWebhook(parsed.data.action),
          context.requestId
        ),
    })
    return apiJson(result.body, {
      status: result.status,
      headers: result.replayed ? { "Idempotency-Replayed": "true" } : undefined,
    })
  } catch (error) {
    if (error instanceof DomainMonitoringError) {
      return apiError(
        context.requestId,
        error.code === "WEBHOOK_URL_INVALID" ? 503 : 409,
        error.code,
        error.message
      )
    }
    return routeError(error, context.requestId)
  }
}
