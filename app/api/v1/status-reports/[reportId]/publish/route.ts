import { authorize, isApiResponse } from "@/lib/api/middleware";
import { collectStatusReportPaths, runStatusReportMutation } from "@/lib/api/status-report-http";
import { createDatabaseStatusReportsStore, publishStatusReport } from "@/lib/api/status-reports";

export async function POST(request: Request, { params }: { params: Promise<{ reportId: string }> }) {
  const context = await authorize(request, { scope: "reports:write" });
  if (isApiResponse(context)) return context;
  const reportId = (await params).reportId;
  return runStatusReportMutation({
    request,
    context,
    routeKey: `/api/v1/status-reports/${reportId}/publish`,
    body: {},
    work: async (tx) => {
      const store = createDatabaseStatusReportsStore(tx);
      const report = await publishStatusReport(reportId, { store });
      const revalidatePaths = await collectStatusReportPaths(report, [], store);
      return { status: 200, kind: "StatusReport", data: report, revalidatePaths };
    },
  });
}
