import { apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import {
  revalidateStatusReportPaths,
  statusReportRouteError,
  storedStatusReportError,
} from "@/lib/api/status-report-http";
import { publishStatusReport, StatusReportError } from "@/lib/api/status-reports";

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
      // ALREADY_PUBLISHED / REPORT_NOT_FOUND are deterministic outcomes of the
      // CURRENT report state, not proof this operation ever ran — they're
      // mapped and recorded as this operation's own response here rather than
      // thrown past executeIdempotent (finding: a thrown 409 left the
      // idempotency record stuck "running" until a stale reclaim's recover
      // callback saw the exact "already published" state a genuine conflict
      // would also produce, and replayed it as a false 200). No recover
      // callback: a retry with the same key now replays the recorded 409/404
      // (or 200) verbatim via the ordinary completed-record path, and a
      // genuine prior success replays the same way.
      work: async () => {
        try {
          const report = await publishStatusReport(reportId);
          await revalidateStatusReportPaths(report);
          return { status: 200, body: objectEnvelope("StatusReport", report, context.requestId) };
        } catch (error) {
          if (error instanceof StatusReportError) return storedStatusReportError(error, context.requestId);
          throw error;
        }
      },
    });
    return apiJson(result.body, { status: result.status });
  } catch (error) {
    return statusReportRouteError(error, context.requestId);
  }
}
