import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { configurationService, configErrorCode } from "@/lib/api/config-service";
import { exportDeclarativeConfig } from "@/lib/config";

export async function GET(request: Request) {
  const context = await authorize(request, { scope: "config:read" });
  if (isApiResponse(context)) return context;
  try {
    const current = await configurationService.get();
    const response = apiJson({ ...objectEnvelope("Configuration", exportDeclarativeConfig(current.config), context.requestId), meta: { requestId: context.requestId, configHash: current.hash } });
    response.headers.set("ETag", `"${current.hash}"`);
    return response;
  } catch (error) {
    return apiError(context.requestId, 503, configErrorCode(error) ?? "CONFIG_UNAVAILABLE", "Configuration is unavailable");
  }
}
