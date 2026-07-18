import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { operationalService } from "@/lib/api/operational-service";

export async function GET(request: Request) {
  const context = await authorize(request, { scope: "status:read" });
  if (isApiResponse(context)) return context;
  try {
    return apiJson(objectEnvelope("Status", await operationalService.getStatus(), context.requestId));
  } catch {
    return apiError(context.requestId, 500, "INTERNAL_ERROR", "The request could not be completed");
  }
}
