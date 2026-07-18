import { apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import {
  revalidateStatusReportPaths,
  statusReportPatchAlreadyApplied,
  statusReportRouteError,
  storedStatusReportError,
} from "@/lib/api/status-report-http";
import { deleteStatusReport, getStatusReport, StatusReportError, updateStatusReport } from "@/lib/api/status-reports";

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
        try {
          // Replacing the affected set can move the report between group
          // pages; capture the pre-patch snapshot so the pages it leaves
          // refresh too.
          const previous = body !== null && typeof body === "object" && "affected" in body
            ? await getStatusReport(reportId).catch(() => null)
            : null;
          const report = await updateStatusReport(reportId, body);
          await revalidateStatusReportPaths(report, previous?.affected ?? []);
          return { status: 200, body: objectEnvelope("StatusReport", report, context.requestId) };
        } catch (error) {
          // VALIDATION_ERROR / REPORT_NOT_FOUND are deterministic outcomes of
          // the request/CURRENT state, not proof this operation ever ran —
          // recorded here rather than thrown past executeIdempotent (finding:
          // a thrown error left the idempotency record stuck "running" until
          // a stale reclaim's recover callback fell through to `true` for an
          // invalid patch body and replayed a false 200 instead of the
          // genuine 400).
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
      // REPORT_NOT_FOUND is a deterministic outcome of the CURRENT state, not
      // proof this operation ever ran — it's mapped and recorded as this
      // operation's own response here rather than thrown past
      // executeIdempotent (finding: a thrown 404 left the idempotency record
      // stuck "running" until a stale reclaim's recover callback saw the
      // exact "report is gone" state a genuine 404 would also produce, and
      // replayed it as a false 200). No recover callback: a retry with the
      // same key now replays the recorded 404 (or 200) verbatim via the
      // ordinary completed-record path, and a genuine prior success replays
      // the same way.
      work: async () => {
        try {
          const report = await getStatusReport(reportId);
          await deleteStatusReport(reportId);
          await revalidateStatusReportPaths(report);
          return { status: 200, body: objectEnvelope("StatusReportDeleted", { id: reportId }, context.requestId) };
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
