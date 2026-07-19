import { authorize, isApiResponse } from "@/lib/api/middleware";
import { revalidateStatusReportPaths, runStatusReportMutation, statusReportRouteError } from "@/lib/api/status-report-http";
import {
  deleteReportUpdate,
  editReportUpdate,
  recoverDeletedReportUpdate,
  recoverEditedReportUpdate,
} from "@/lib/api/status-reports";

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
    // Recovers only when the CURRENT update already reflects everything this
    // patch asked for; a genuinely different state (or an unknown
    // report/update) returns null so work() reruns.
    recover: async () => {
      const recovered = await recoverEditedReportUpdate(reportId, updateId, body);
      if (!recovered) return null;
      // The crash this recovers from may have landed between the edit
      // committing and revalidation running, so ISR pages must be refreshed
      // here too, same as the normal work() path below.
      await revalidateStatusReportPaths(recovered);
      return { status: 200, kind: "StatusReport", data: recovered };
    },
    work: async () => {
      const report = await editReportUpdate(reportId, updateId, body);
      await revalidateStatusReportPaths(report);
      return { status: 200, kind: "StatusReport", data: report };
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
    // deleteUpdate is a row-locked, guarded delete: a concurrent delete of
    // the SAME update would itself observe it already gone and record its
    // own UPDATE_NOT_FOUND rather than staying "running", so a record left
    // running here, with the update now gone, proves THIS operation deleted
    // it.
    recover: async () => {
      const recovered = await recoverDeletedReportUpdate(reportId, updateId);
      if (!recovered) return null;
      // The crash this recovers from may have landed between the delete
      // committing and revalidation running, so ISR pages must be refreshed
      // here too, same as the normal work() path below.
      await revalidateStatusReportPaths(recovered);
      return { status: 200, kind: "StatusReport", data: recovered };
    },
    work: async () => {
      const report = await deleteReportUpdate(reportId, updateId);
      await revalidateStatusReportPaths(report);
      return { status: 200, kind: "StatusReport", data: report };
    },
  });
}
