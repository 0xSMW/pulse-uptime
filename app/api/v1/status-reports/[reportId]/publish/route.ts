import { authorize, isApiResponse } from "@/lib/api/middleware";
import { revalidateStatusReportPaths, runStatusReportMutation } from "@/lib/api/status-report-http";
import { publishStatusReport, recoverPublishedStatusReport } from "@/lib/api/status-reports";

export async function POST(request: Request, { params }: { params: Promise<{ reportId: string }> }) {
  const context = await authorize(request, { scope: "reports:write" });
  if (isApiResponse(context)) return context;
  const reportId = (await params).reportId;
  return runStatusReportMutation({
    request,
    context,
    routeKey: `/api/v1/status-reports/${reportId}/publish`,
    body: {},
    // The guarded UPDATE ... WHERE published_at IS NULL makes recovery safe:
    // a concurrent publish of the SAME report would itself observe the row
    // already published and record its own 409 rather than staying
    // "running", so a record left running here, with the report now
    // published, proves THIS operation published it. An unpublished or
    // now-missing report returns null so work() reruns.
    recover: async () => {
      const recovered = await recoverPublishedStatusReport(reportId);
      if (!recovered) return null;
      // The crash this recovers from may have landed between the publish
      // committing and revalidation running; the report just became
      // public, so ISR pages must be refreshed here too, same as the normal
      // work() path below.
      await revalidateStatusReportPaths(recovered);
      return { status: 200, kind: "StatusReport", data: recovered };
    },
    work: async () => {
      const report = await publishStatusReport(reportId);
      await revalidateStatusReportPaths(report);
      return { status: 200, kind: "StatusReport", data: report };
    },
  });
}
