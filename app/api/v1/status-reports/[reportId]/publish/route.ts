import { apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { revalidateStatusReportPaths, statusReportRouteError } from "@/lib/api/status-report-http";
import { getStatusReport, publishStatusReport } from "@/lib/api/status-reports";

export async function POST(request: Request, { params }: { params: Promise<{ reportId: string }> }) {
  const context = await authorize(request, { scope: "reports:write" });
  if (isApiResponse(context)) return context;
  const reportId = (await params).reportId;
  try {
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: `/api/v1/status-reports/${reportId}/publish`,
      body: {},
      // A retry after a stale-record reclaim means a prior attempt may have
      // already committed the publish before crashing (finding: a committed
      // publish makes the retry rerun and hit ALREADY_PUBLISHED, so the
      // client sees a 409 for a publish that actually succeeded). If the
      // report is already published, treat that as this operation's own
      // recovered success; if it isn't (or is missing), fall through to
      // work() — publishStatusReport is safe to rerun and still 409s a
      // GENUINE double-publish from a different operation.
      recover: async () => {
        const report = await getStatusReport(reportId).catch(() => null);
        return report?.publishedAt
          ? { status: 200, body: objectEnvelope("StatusReport", report, context.requestId) }
          : null;
      },
      work: async () => {
        const report = await publishStatusReport(reportId);
        await revalidateStatusReportPaths(report);
        return { status: 200, body: objectEnvelope("StatusReport", report, context.requestId) };
      },
    });
    return apiJson(result.body, { status: result.status });
  } catch (error) {
    return statusReportRouteError(error, context.requestId);
  }
}
