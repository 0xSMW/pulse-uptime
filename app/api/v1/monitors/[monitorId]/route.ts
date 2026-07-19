import { z } from "zod";

import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { routeError, success } from "@/lib/api/route";
import { deleteMonitor, getMonitor, MonitorApiError, updateMonitor } from "@/lib/api/monitors";

type Params = { params: Promise<{ monitorId: string }> };

function monitorError(error: unknown, requestId: string): Response | null {
  if (error instanceof MonitorApiError) {
    const status = error.code === "MONITOR_NOT_FOUND" ? 404 : error.code === "MONITOR_EXISTS" ? 409 : error.code === "INVALID_REQUEST" ? 400 : 503;
    return apiError(requestId, status, error.code, error.message);
  }
  if (error instanceof z.ZodError) return apiError(requestId, 400, "INVALID_REQUEST", "Monitor request is invalid", { issues: error.issues });
  return null;
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
      work: async ({ transaction }) => transaction(async (tx) => ({ status: 200, body: objectEnvelope("Monitor", await updateMonitor(monitorId, body, context.principalKey, tx), context.requestId) })),
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
      work: async ({ transaction }) => transaction(async (tx) => ({ status: 200, body: objectEnvelope("MonitorDeletion", await deleteMonitor(monitorId, context.principalKey, tx), context.requestId) })),
    });
    return apiJson(result.body, { status: result.status });
  } catch (error) { return monitorError(error, context.requestId) ?? routeError(error, context.requestId); }
}
