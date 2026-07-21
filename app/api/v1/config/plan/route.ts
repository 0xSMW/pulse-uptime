import { ZodError } from "zod"
import { configErrorCode, configurationService } from "@/lib/api/config-service"
import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { authorize, isApiResponse } from "@/lib/api/middleware"

export async function POST(request: Request) {
  const context = await authorize(request, { scope: "config:write" })
  if (isApiResponse(context)) {
    return context
  }
  try {
    const body = (await request.json()) as {
      baseConfigHash?: unknown
      targetConfig?: unknown
    }
    if (typeof body.baseConfigHash !== "string") {
      return apiError(
        context.requestId,
        400,
        "INVALID_REQUEST",
        "baseConfigHash is required"
      )
    }
    const plan = await configurationService.plan({
      baseConfigHash: body.baseConfigHash,
      targetConfig: body.targetConfig,
    })
    return apiJson(
      objectEnvelope(
        "ConfigurationPlan",
        {
          baseConfigHash: plan.baseConfigHash,
          targetConfigHash: plan.targetConfigHash,
          planHash: plan.planHash,
          diff: plan.diff,
          destructiveConsentRequired: plan.destructiveConsentRequired,
          destructiveChange: plan.destructiveChange,
        },
        context.requestId
      )
    )
  } catch (error) {
    if (error instanceof SyntaxError) {
      return apiError(
        context.requestId,
        400,
        "INVALID_JSON",
        "Request body must be valid JSON"
      )
    }
    if (error instanceof ZodError) {
      return apiError(
        context.requestId,
        400,
        "INVALID_CONFIG",
        "Configuration validation failed",
        { issues: error.issues }
      )
    }
    const code = configErrorCode(error)
    return apiError(
      context.requestId,
      code === "CONFIG_VERSION_CONFLICT" ? 409 : 500,
      code ?? "CONFIG_PLAN_FAILED",
      "Configuration plan could not be created"
    )
  }
}
