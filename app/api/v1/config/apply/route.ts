import { ZodError } from "zod";
import { executeIdempotent } from "@/lib/api/idempotency";
import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { CONFIG_OPERATION_RETENTION_SECONDS, configurationService, configErrorCode } from "@/lib/api/config-service";
import type { ConfigurationApplyRequest } from "@/lib/config";

export async function POST(request: Request) {
  const context = await authorize(request, { scope: "config:write" });
  if (isApiResponse(context)) return context;
  try {
    const body = await request.json() as ConfigurationApplyRequest;
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    const result = await executeIdempotent({ request, principalKey: context.principalKey, routeKey: "config.apply", body,
      retentionSeconds: CONFIG_OPERATION_RETENTION_SECONDS,
      work: async () => ({ status: 202, body: objectEnvelope("ConfigurationOperation", await configurationService.apply({ principalKey: context.principalKey, requestId: context.requestId, idempotencyKey, ifMatch: request.headers.get("if-match"), request: body }), context.requestId) }),
    });
    return apiJson(result.body, { status: result.status, headers: result.replayed ? { "Idempotency-Replayed": "true" } : undefined });
  } catch (error) {
    if (error instanceof SyntaxError) return apiError(context.requestId, 400, "INVALID_JSON", "Request body must be valid JSON");
    if (error instanceof ZodError) return apiError(context.requestId, 400, "INVALID_CONFIG", "Configuration validation failed", { issues: error.issues });
    const code = configErrorCode(error);
    const status = code === "PRECONDITION_MISMATCH" || code === "TARGET_CONFIG_HASH_MISMATCH" || code === "PLAN_HASH_MISMATCH" || code === "DELETE_NOT_ALLOWED"
      ? 400
      : code === "CONFIG_VERSION_CONFLICT" ? 409 : code === "EDGE_CONFIG_WRITE_FAILED" ? 503 : 500;
    return apiError(context.requestId, status, code ?? "CONFIG_APPLY_FAILED", "Configuration apply could not be completed");
  }
}
