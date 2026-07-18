import { apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import {
  revalidateStatusReportPaths,
  statusReportRouteError,
  storedStatusReportError,
} from "@/lib/api/status-report-http";
import {
  deleteReportUpdate,
  editReportUpdate,
  recoverEditedReportUpdate,
  StatusReportError,
} from "@/lib/api/status-reports";

type Params = { params: Promise<{ reportId: string; updateId: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "reports:write" });
  if (isApiResponse(context)) return context;
  const { reportId, updateId } = await params;
  try {
    const body = await request.json();
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: `/api/v1/status-reports/${reportId}/updates/${updateId}`,
      body,
      // A retry after a stale-record reclaim means a prior attempt may have
      // already committed the edit before crashing (finding: the retry would
      // rerun editUpdate and persistResolutionAndSerialize's recompute a
      // second time). If the CURRENT update already reflects everything this
      // patch asked for, recover by serializing the current state as this
      // operation's own success; otherwise return null so work() reruns (a
      // genuinely different current state, or an unknown report/update,
      // still hits the normal error mapping).
      recover: async () => {
        const recovered = await recoverEditedReportUpdate(reportId, updateId, body);
        return recovered ? { status: 200, body: objectEnvelope("StatusReport", recovered, context.requestId) } : null;
      },
      work: async () => {
        try {
          const report = await editReportUpdate(reportId, updateId, body);
          await revalidateStatusReportPaths(report);
          return { status: 200, body: objectEnvelope("StatusReport", report, context.requestId) };
        } catch (error) {
          // VALIDATION_ERROR / REPORT_NOT_FOUND / UPDATE_NOT_FOUND are
          // deterministic outcomes of the request/CURRENT state, not proof
          // this operation ever ran — recorded here rather than thrown past
          // executeIdempotent (finding: a thrown error left the idempotency
          // record stuck "running" until a stale reclaim's recover callback
          // fell through to `true` for an invalid patch body and replayed a
          // false 200 instead of the genuine 400).
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
  const { reportId, updateId } = await params;
  try {
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: `/api/v1/status-reports/${reportId}/updates/${updateId}`,
      body: {},
      // UPDATE_NOT_FOUND / REPORT_NOT_FOUND / LAST_UPDATE are deterministic
      // outcomes of the CURRENT state, not proof this operation ever ran —
      // they're mapped and recorded as this operation's own response here
      // rather than thrown past executeIdempotent (finding: a thrown error
      // left the idempotency record stuck "running" until a stale reclaim's
      // recover callback saw the exact state a genuine 404 would also
      // produce — the update already gone — and replayed it as a false 200).
      // No recover callback: a retry with the same key now replays the
      // recorded 404/409 (or 200) verbatim via the ordinary completed-record
      // path, and a genuine prior success replays the same way.
      work: async () => {
        try {
          const report = await deleteReportUpdate(reportId, updateId);
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
