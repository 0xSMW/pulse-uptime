import { apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { revalidateStatusReportPaths, statusReportRouteError } from "@/lib/api/status-report-http";
import { addReportUpdate, recoverAddedReportUpdate } from "@/lib/api/status-reports";

export async function POST(request: Request, { params }: { params: Promise<{ reportId: string }> }) {
  const context = await authorize(request, { scope: "reports:write" });
  if (isApiResponse(context)) return context;
  const reportId = (await params).reportId;
  try {
    const body = await request.json();
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: `/api/v1/status-reports/${reportId}/updates`,
      body,
      // See POST /status-reports: recover the update by the id pinned to the
      // idempotency operation instead of re-inserting a second update after a
      // stale-record reclaim.
      recover: async ({ operationId }) => {
        const report = await recoverAddedReportUpdate(reportId, operationId);
        return report ? { status: 201, body: objectEnvelope("StatusReport", report, context.requestId) } : null;
      },
      rerunAfterRecoveryMiss: false,
      work: async ({ operationId }) => {
        const report = await addReportUpdate(reportId, body, { updateId: operationId });
        await revalidateStatusReportPaths(report);
        return { status: 201, body: objectEnvelope("StatusReport", report, context.requestId) };
      },
    });
    return apiJson(result.body, { status: result.status });
  } catch (error) {
    return statusReportRouteError(error, context.requestId);
  }
}
