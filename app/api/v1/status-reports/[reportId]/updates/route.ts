import { authorize, isApiResponse } from "@/lib/api/middleware";
import { revalidateStatusReportPaths, runStatusReportMutation, statusReportRouteError } from "@/lib/api/status-report-http";
import { addReportUpdate, recoverAddedReportUpdate } from "@/lib/api/status-reports";

export async function POST(request: Request, { params }: { params: Promise<{ reportId: string }> }) {
  const context = await authorize(request, { scope: "reports:write" });
  if (isApiResponse(context)) return context;
  const reportId = (await params).reportId;
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    return statusReportRouteError(error, context.requestId);
  }
  return runStatusReportMutation({
    request,
    context,
    routeKey: `/api/v1/status-reports/${reportId}/updates`,
    body,
    // Recover the update by the id pinned to this operation instead of
    // re-inserting a second update after a stale-record reclaim.
    recover: async ({ operationId }) => {
      const report = await recoverAddedReportUpdate(reportId, operationId);
      if (!report) return null;
      // The crash this recovers from may have landed between the insert
      // committing and revalidation running, so ISR pages must be refreshed
      // here too, same as the normal work() path below.
      await revalidateStatusReportPaths(report);
      return { status: 201, kind: "StatusReport", data: report };
    },
    work: async ({ operationId }) => {
      const report = await addReportUpdate(reportId, body, { updateId: operationId });
      await revalidateStatusReportPaths(report);
      return { status: 201, kind: "StatusReport", data: report };
    },
  });
}
