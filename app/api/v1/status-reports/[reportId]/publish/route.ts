import { apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import {
  revalidateStatusReportPaths,
  statusReportRouteError,
  storedStatusReportError,
} from "@/lib/api/status-report-http";
import { publishStatusReport, recoverPublishedStatusReport, StatusReportError } from "@/lib/api/status-reports";

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
      // A retry after a stale-record reclaim may be replaying a publish that
      // already committed before a crash (finding: with no recover callback,
      // rerunning hit the guarded UPDATE ... WHERE published_at IS NULL,
      // observed zero rows, and recorded a false ALREADY_PUBLISHED 409 for
      // what was actually this operation's own success). The guard is what
      // makes recovering safe: a concurrent publish of the SAME report would
      // itself observe the row already published and record its own 409
      // rather than staying "running" — so a record left running here, with
      // the report now published, proves THIS operation is what published
      // it. An unpublished or now-missing report returns null so work()
      // reruns and records the genuine outcome.
      recover: async () => {
        const recovered = await recoverPublishedStatusReport(reportId);
        return recovered ? { status: 200, body: objectEnvelope("StatusReport", recovered, context.requestId) } : null;
      },
      rerunAfterRecoveryMiss: false,
      // ALREADY_PUBLISHED / REPORT_NOT_FOUND are deterministic outcomes of
      // the CURRENT report state, not proof this operation ever ran — they're
      // mapped and recorded as this operation's own response here rather than
      // thrown past executeIdempotent (finding: a thrown 409 left the
      // idempotency record stuck "running" until a stale reclaim's recover
      // callback saw the exact "already published" state a genuine conflict
      // would also produce, and replayed it as a false 200).
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
