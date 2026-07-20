import { z } from "zod";

import { apiError, apiJson, errorEnvelope, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent, type StoredResponse } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { routeError, success } from "@/lib/api/route";
import { archiveMonitor, getMonitor, MonitorApiError, updateMonitor } from "@/lib/api/monitors";

type Params = { params: Promise<{ monitorId: string }> };

function monitorError(error: unknown, requestId: string): Response | null {
  if (error instanceof MonitorApiError) {
    const status = error.code === "MONITOR_NOT_FOUND" ? 404 : error.code === "MONITOR_EXISTS" ? 409 : error.code === "INVALID_REQUEST" ? 400 : 503;
    return apiError(requestId, status, error.code, error.message);
  }
  if (error instanceof z.ZodError) return apiError(requestId, 400, "INVALID_REQUEST", "Monitor request is invalid", { issues: error.issues });
  return null;
}

// MONITOR_NOT_FOUND/MONITOR_EXISTS/INVALID_REQUEST are deterministic outcomes
// of this request, not proof it never ran, so store them as the operation's
// own completed response instead of letting them roll back the transaction.
// A stale-window retry would otherwise rerun updateMonitor/archiveMonitor
// against whatever config exists by then (e.g. a monitor created later).
// CONFIGURATION_UNAVAILABLE/EDGE_CONFIG_UNAVAILABLE are transient infra
// failures, not request outcomes, so those still propagate and roll back.
function storedMonitorError(error: unknown, requestId: string): StoredResponse | null {
  if (!(error instanceof MonitorApiError)) return null;
  const status = error.code === "MONITOR_NOT_FOUND" ? 404 : error.code === "MONITOR_EXISTS" ? 409 : error.code === "INVALID_REQUEST" ? 400 : null;
  return status ? { status, body: errorEnvelope(error.code, error.message, requestId) } : null;
}

export async function GET(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "monitors:read" });
  if (isApiResponse(context)) return context;
  try { return success("Monitor", await getMonitor((await params).monitorId), context.requestId); }
  catch (error) { return monitorError(error, context.requestId) ?? routeError(error, context.requestId); }
}

export async function PATCH(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "monitors:write" });
  if (isApiResponse(context)) return context;
  const monitorId = (await params).monitorId;
  try {
    const body = await request.json();
    const result = await executeIdempotent({ request, principalKey: context.principalKey, routeKey: `/api/v1/monitors/${monitorId}`, body,
      work: async ({ transaction }) => transaction(async (tx) => {
        try {
          return { status: 200, body: objectEnvelope("Monitor", await updateMonitor(monitorId, body, context.principalKey, tx), context.requestId) };
        } catch (error) {
          const stored = storedMonitorError(error, context.requestId);
          if (stored) return stored;
          throw error;
        }
      }),
    });
    return apiJson(result.body, { status: result.status });
  } catch (error) { return monitorError(error, context.requestId) ?? routeError(error, context.requestId); }
}

export async function DELETE(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "monitors:write" });
  if (isApiResponse(context)) return context;
  const monitorId = (await params).monitorId;
  try {
    const result = await executeIdempotent({ request, principalKey: context.principalKey, routeKey: `/api/v1/monitors/${monitorId}`, body: {},
      work: async ({ transaction }) => transaction(async (tx) => {
        try {
          return { status: 200, body: objectEnvelope("MonitorArchival", await archiveMonitor(monitorId, context.principalKey, tx), context.requestId) };
        } catch (error) {
          const stored = storedMonitorError(error, context.requestId);
          if (stored) return stored;
          throw error;
        }
      }),
    });
    return apiJson(result.body, { status: result.status });
  } catch (error) { return monitorError(error, context.requestId) ?? routeError(error, context.requestId); }
}
