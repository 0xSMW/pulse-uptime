import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { routeError } from "@/lib/api/route";
import { MonitorApiError, recoverMonitorEnabled, setMonitorEnabled } from "@/lib/api/monitors";

export async function POST(request: Request, { params }: { params: Promise<{ monitorId: string }> }) {
  const context = await authorize(request, { scope: "monitors:write" });
  if (isApiResponse(context)) return context;
  const id = (await params).monitorId;
  try {
    const result = await executeIdempotent({ request, principalKey: context.principalKey, routeKey: `/api/v1/monitors/${id}/pause`, body: {},
      recover: async () => {
        const monitor = await recoverMonitorEnabled(id, false);
        return monitor ? { status: 200, body: objectEnvelope("Monitor", monitor, context.requestId) } : null;
      },
      work: async () => ({ status: 200, body: objectEnvelope("Monitor", await setMonitorEnabled(id, false, context.principalKey), context.requestId) }),
    });
    return apiJson(result.body, { status: result.status });
  } catch (error) {
    if (error instanceof MonitorApiError) return apiError(context.requestId, error.code === "MONITOR_NOT_FOUND" ? 404 : 503, error.code, error.message);
    return routeError(error, context.requestId);
  }
}
