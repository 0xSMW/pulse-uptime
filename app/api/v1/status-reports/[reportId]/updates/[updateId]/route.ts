import { apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { revalidateStatusReportPaths, statusReportRouteError } from "@/lib/api/status-report-http";
import { deleteReportUpdate, editReportUpdate, recoverDeletedReportUpdate } from "@/lib/api/status-reports";

type Params = { params: Promise<{ reportId: string; updateId: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "reports:write" });
  if (isApiResponse(context)) return context;
  const { reportId, updateId } = await params;
  try {
    const body = await request.json();
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: `/api/v1/status-reports/${reportId}/updates/${updateId}`,
      body,
      work: async () => {
        const report = await editReportUpdate(reportId, updateId, body);
        await revalidateStatusReportPaths(report);
        return { status: 200, body: objectEnvelope("StatusReport", report, context.requestId) };
      },
    });
    return apiJson(result.body, { status: result.status });
  } catch (error) {
    return statusReportRouteError(error, context.requestId);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "reports:write" });
  if (isApiResponse(context)) return context;
  const { reportId, updateId } = await params;
  try {
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: `/api/v1/status-reports/${reportId}/updates/${updateId}`,
      body: {},
      // A retry after a stale-record reclaim means a prior attempt may have
      // already committed the delete before crashing (finding: the retry
      // would rerun into UPDATE_NOT_FOUND -> 404 for a delete that actually
      // succeeded). If the update is gone but the report still exists,
      // recover by recomputing/serializing the current state as this
      // operation's own success; otherwise return null so work() reruns
      // (a still-present update, or a genuinely-unknown one on a first
      // attempt, still hits the normal error mapping).
      recover: async () => {
        const recovered = await recoverDeletedReportUpdate(reportId, updateId);
        return recovered ? { status: 200, body: objectEnvelope("StatusReport", recovered, context.requestId) } : null;
      },
      work: async () => {
        const report = await deleteReportUpdate(reportId, updateId);
        await revalidateStatusReportPaths(report);
        return { status: 200, body: objectEnvelope("StatusReport", report, context.requestId) };
      },
    });
    return apiJson(result.body, { status: result.status });
  } catch (error) {
    return statusReportRouteError(error, context.requestId);
  }
}
