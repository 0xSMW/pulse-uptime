import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { routeError } from "@/lib/api/route";
import {
  getStatusPageConfig,
  putStatusPageConfig,
  StatusPageConfigError,
  type StatusPageConfigData,
} from "@/lib/api/status-page-config";

function configResponse(data: StatusPageConfigData, etag: string, requestId: string) {
  const response = apiJson(objectEnvelope("StatusPageConfig", data, requestId));
  response.headers.set("ETag", etag);
  return response;
}

function configError(error: unknown, requestId: string) {
  if (error instanceof StatusPageConfigError) {
    const status = error.code === "PRECONDITION_FAILED" ? 412 : error.code === "CONFIG_UNAVAILABLE" ? 503 : 400;
    return apiError(requestId, status, error.code, error.message, error.details);
  }
  return routeError(error, requestId);
}

export async function GET(request: Request) {
  const context = await authorize(request, { scope: "config:read" });
  if (isApiResponse(context)) return context;
  try {
    const { data, etag } = await getStatusPageConfig();
    return configResponse(data, etag, context.requestId);
  } catch (error) {
    return configError(error, context.requestId);
  }
}

export async function PUT(request: Request) {
  const context = await authorize(request, { scope: "config:write" });
  if (isApiResponse(context)) return context;
  const ifMatch = request.headers.get("if-match")?.trim();
  if (!ifMatch) {
    return apiError(
      context.requestId,
      428,
      "PRECONDITION_REQUIRED",
      "The If-Match header is required; read the configuration and resend with its ETag",
    );
  }
  try {
    const { data, etag } = await putStatusPageConfig(await request.json(), ifMatch);
    return configResponse(data, etag, context.requestId);
  } catch (error) {
    return configError(error, context.requestId);
  }
}
