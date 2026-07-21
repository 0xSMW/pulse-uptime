import { configurationService } from "@/lib/api/config-service"
import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { authorize, isApiResponse } from "@/lib/api/middleware"

export async function GET(request: Request) {
  const context = await authorize(request, { scope: "config:read" })
  if (isApiResponse(context)) {
    return context
  }
  try {
    return apiJson(
      objectEnvelope(
        "ConfigurationSchema",
        await configurationService.schema(),
        context.requestId
      )
    )
  } catch {
    return apiError(
      context.requestId,
      500,
      "CONFIG_SCHEMA_UNAVAILABLE",
      "Configuration schema is unavailable"
    )
  }
}
