import { ZodError } from "zod";
import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { configurationService } from "@/lib/api/config-service";

export async function POST(request: Request) {
  const context = await authorize(request, { scope: "config:write" });
  if (isApiResponse(context)) return context;
  try {
    await configurationService.validate(await request.json());
    return apiJson(objectEnvelope("ConfigurationValidation", { valid: true, errors: [] }, context.requestId));
  }
  catch (error) {
    if (error instanceof SyntaxError) return apiError(context.requestId, 400, "INVALID_JSON", "Request body must be valid JSON");
    if (error instanceof ZodError) return apiError(context.requestId, 400, "INVALID_CONFIG", "Configuration validation failed", { issues: error.issues });
    return apiError(context.requestId, 400, "INVALID_CONFIG", "Configuration validation failed");
  }
}
