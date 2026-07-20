import { authorize, isApiResponse } from "@/lib/api/middleware";
import { collectStatusReportPaths, runStatusReportMutation, statusReportRouteError } from "@/lib/api/status-report-http";
import { createDatabaseStatusReportsStore, deleteReportUpdate, editReportUpdate } from "@/lib/api/status-reports";

type Params = { params: Promise<{ reportId: string; updateId: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "reports:write" });
  if (isApiResponse(context)) return context;
  const { reportId, updateId } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    return statusReportRouteError(error, context.requestId);
  }
  return runStatusReportMutation({
    request,
    context,
    routeKey: `/api/v1/status-reports/${reportId}/updates/${updateId}`,
    body,
    work: async (tx) => {
      const store = createDatabaseStatusReportsStore(tx);
      const report = await editReportUpdate(reportId, updateId, body, { store });
      const revalidatePaths = await collectStatusReportPaths(report, [], store);
      return { status: 200, kind: "StatusReport", data: report, revalidatePaths };
    },
  });
}

export async function DELETE(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "reports:write" });
  if (isApiResponse(context)) return context;
  const { reportId, updateId } = await params;
  return runStatusReportMutation({
    request,
    context,
    routeKey: `/api/v1/status-reports/${reportId}/updates/${updateId}`,
    body: {},
    work: async (tx) => {
      const store = createDatabaseStatusReportsStore(tx);
      const report = await deleteReportUpdate(reportId, updateId, { store });
      const revalidatePaths = await collectStatusReportPaths(report, [], store);
      return { status: 200, kind: "StatusReport", data: report, revalidatePaths };
    },
  });
}
