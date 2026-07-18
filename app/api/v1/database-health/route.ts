import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { routeError } from "@/lib/api/route";
import { getDatabaseHealth } from "@/lib/database-health";

export async function GET(request: Request) {
  const context = await authorize(request, { scope: "config:read" });
  if (isApiResponse(context)) return context;
  try {
    const health = await getDatabaseHealth();
    if (!health) {
      return apiError(
        context.requestId,
        503,
        "DATABASE_HEALTH_UNAVAILABLE",
        "Database health measurements are unavailable",
      );
    }
    return apiJson(objectEnvelope("DatabaseHealth", health, context.requestId));
  } catch (error) {
    return routeError(error, context.requestId);
  }
}
