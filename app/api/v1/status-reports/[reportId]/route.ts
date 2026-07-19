import { revalidatePath } from "next/cache";

import { apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import {
  revalidateStatusReportPaths,
  runStatusReportMutation,
  statusReportPatchAlreadyApplied,
  statusReportRouteError,
} from "@/lib/api/status-report-http";
import { deleteStatusReport, getStatusReport, recoverDeletedStatusReport, updateStatusReport } from "@/lib/api/status-reports";

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
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    return statusReportRouteError(error, context.requestId);
  }
  return runStatusReportMutation({
    request,
    context,
    routeKey: `/api/v1/status-reports/${reportId}`,
    body,
    // Recovers only when the CURRENT report already reflects everything this
    // patch asked for. A genuinely different state (or an unknown report)
    // returns null so work() reruns rather than re-snapshotting affected
    // monitors on top of a rename/move a rerun would otherwise clobber.
    recover: async () => {
      const current = await getStatusReport(reportId).catch(() => null);
      if (!current || !statusReportPatchAlreadyApplied(current, body)) return null;
      // The crash this recovers from may have landed between the patch
      // committing and revalidation running, so ISR pages must be refreshed
      // here too, same as the normal work() path below. The pre-patch
      // affected snapshot is unavailable at recovery time (the crashed
      // attempt already applied the patch), so this can only revalidate the
      // CURRENT affected set, not a group page the report left. That residual
      // is bounded by the 30 s ISR window, same as findMonitors' best-effort
      // catch inside revalidateStatusReportPaths itself.
      await revalidateStatusReportPaths(current);
      return { status: 200, kind: "StatusReport", data: current };
    },
    work: async () => {
      // Replacing the affected set can move the report between group pages.
      // Capture the pre-patch snapshot so the pages it leaves also refresh.
      const previous = body !== null && typeof body === "object" && "affected" in body
        ? await getStatusReport(reportId).catch(() => null)
        : null;
      const report = await updateStatusReport(reportId, body);
      await revalidateStatusReportPaths(report, previous?.affected ?? []);
      return { status: 200, kind: "StatusReport", data: report };
    },
  });
}

export async function DELETE(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "reports:write" });
  if (isApiResponse(context)) return context;
  const reportId = (await params).reportId;
  return runStatusReportMutation({
    request,
    context,
    routeKey: `/api/v1/status-reports/${reportId}`,
    body: {},
    // deleteReport is a guarded DELETE ... RETURNING: a concurrent delete of
    // the SAME report would itself observe zero rows and record its own
    // REPORT_NOT_FOUND rather than staying "running", so a record left
    // running here, with the report now gone, proves THIS operation deleted
    // it. A report that still exists returns null so work() reruns.
    recover: async () => {
      const recovered = await recoverDeletedStatusReport(reportId);
      if (!recovered) return null;
      // The crash this recovers from may have landed between the delete
      // committing and revalidation running. The report is gone, so there's
      // no report object left to derive group slugs from (unlike the other
      // recover closures in this family), fall back to the same blanket
      // whole-surface revalidation the config PUT route uses for exactly
      // this case, rather than skipping revalidation entirely.
      revalidatePath("/status", "layout");
      return { status: 200, kind: "StatusReportDeleted", data: { id: reportId } };
    },
    work: async () => {
      const report = await getStatusReport(reportId);
      await deleteStatusReport(reportId);
      await revalidateStatusReportPaths(report);
      return { status: 200, kind: "StatusReportDeleted", data: { id: reportId } };
    },
  });
}
