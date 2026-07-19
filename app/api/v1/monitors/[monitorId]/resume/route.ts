import { apiError, apiJson, errorEnvelope, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent, type StoredResponse } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { routeError } from "@/lib/api/route";
import { MonitorApiError, setMonitorEnabled } from "@/lib/api/monitors";

// MONITOR_NOT_FOUND is a deterministic outcome of this request, not proof it
// never ran, so store it as the operation's own completed response instead
// of letting it roll back the transaction. A stale-window retry would
// otherwise rerun setMonitorEnabled against whatever config exists by then.
// CONFIGURATION_UNAVAILABLE/EDGE_CONFIG_UNAVAILABLE are transient infra
// failures, not request outcomes, so those still propagate and roll back.
function storedMonitorError(error: unknown, requestId: string): StoredResponse | null {
  return error instanceof MonitorApiError && error.code === "MONITOR_NOT_FOUND"
    ? { status: 404, body: errorEnvelope(error.code, error.message, requestId) }
    : null;
}

export async function POST(request: Request, { params }: { params: Promise<{ monitorId: string }> }) {
  const context = await authorize(request, { scope: "monitors:write" });
  if (isApiResponse(context)) return context;
  const id = (await params).monitorId;
  try {
    const result = await executeIdempotent({ request, principalKey: context.principalKey, routeKey: `/api/v1/monitors/${id}/resume`, body: {},
      work: async ({ transaction }) => transaction(async (tx) => {
        try {
          return { status: 200, body: objectEnvelope("Monitor", await setMonitorEnabled(id, true, context.principalKey, tx), context.requestId) };
        } catch (error) {
          const stored = storedMonitorError(error, context.requestId);
          if (stored) return stored;
          throw error;
        }
      }),
    });
    return apiJson(result.body, { status: result.status });
  } catch (error) {
    if (error instanceof MonitorApiError) return apiError(context.requestId, error.code === "MONITOR_NOT_FOUND" ? 404 : 503, error.code, error.message);
    return routeError(error, context.requestId);
  }
}
