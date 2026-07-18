import { apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import {
  revalidateStatusReportPaths,
  statusReportPatchAlreadyApplied,
  statusReportRouteError,
} from "@/lib/api/status-report-http";
import { deleteStatusReport, getStatusReport, updateStatusReport } from "@/lib/api/status-reports";

type Params = { params: Promise<{ reportId: string }> };

export async function GET(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "reports:read" });
  if (isApiResponse(context)) return context;
  try {
    const report = await getStatusReport((await params).reportId);
    return apiJson(objectEnvelope("StatusReport", report, context.requestId));
  } catch (error) {
    return statusReportRouteError(error, context.requestId);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "reports:write" });
  if (isApiResponse(context)) return context;
  const reportId = (await params).reportId;
  try {
    const body = await request.json();
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: `/api/v1/status-reports/${reportId}`,
      body,
      // A retry after a stale-record reclaim may be replaying a patch that
      // already committed before a crash (finding: rerunning would re-snapshot
      // affected monitors from the live registry a second time, clobbering a
      // rename/move that happened since). If the CURRENT state already
      // reflects everything this patch asked for, treat that as this
      // operation's own recovered success instead of rerunning work(); a
      // genuinely different current state (or an unknown report) returns
      // null so work() reruns normally.
      recover: async () => {
        const current = await getStatusReport(reportId).catch(() => null);
        if (!current || !statusReportPatchAlreadyApplied(current, body)) return null;
        return { status: 200, body: objectEnvelope("StatusReport", current, context.requestId) };
      },
      work: async () => {
        // Replacing the affected set can move the report between group pages;
        // capture the pre-patch snapshot so the pages it leaves refresh too.
        const previous = body !== null && typeof body === "object" && "affected" in body
          ? await getStatusReport(reportId).catch(() => null)
          : null;
        const report = await updateStatusReport(reportId, body);
        await revalidateStatusReportPaths(report, previous?.affected ?? []);
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
  const reportId = (await params).reportId;
  try {
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: `/api/v1/status-reports/${reportId}`,
      body: {},
      // A retry after a stale-record reclaim means a prior attempt may have
      // already committed the delete before crashing (finding: a committed
      // delete makes the retry rerun getStatusReport against a gone row and
      // 404 for a delete that actually succeeded). This only runs on a
      // reclaimed replay of THIS operation's key — a first attempt against a
      // genuinely-unknown id never reaches here and still 404s via work().
      // If the report still exists, return null so work() reruns the actual
      // delete; if it's gone, treat that as this operation's own recovered
      // success.
      recover: async () => {
        const stillExists = await getStatusReport(reportId).catch(() => null);
        return stillExists
          ? null
          : { status: 200, body: objectEnvelope("StatusReportDeleted", { id: reportId }, context.requestId) };
      },
      work: async () => {
        const report = await getStatusReport(reportId);
        await deleteStatusReport(reportId);
        await revalidateStatusReportPaths(report);
        return { status: 200, body: objectEnvelope("StatusReportDeleted", { id: reportId }, context.requestId) };
      },
    });
    return apiJson(result.body, { status: result.status });
  } catch (error) {
    return statusReportRouteError(error, context.requestId);
  }
}
