import { configurationService } from "@/lib/api/config-service"
import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { authorize, isApiResponse } from "@/lib/api/middleware"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ operationId: string }> }
) {
  const context = await authorize(request, { scope: "config:read" })
  if (isApiResponse(context)) {
    return context
  }
  const operation = await configurationService.operation(
    (await params).operationId
  )
  return operation
    ? apiJson(
        objectEnvelope("ConfigurationOperation", operation, context.requestId)
      )
    : apiError(
        context.requestId,
        404,
        "OPERATION_NOT_FOUND",
        "Configuration operation was not found"
      )
}
