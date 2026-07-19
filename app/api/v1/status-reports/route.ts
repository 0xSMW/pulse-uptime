import { apiError, apiJson, listEnvelope } from "@/lib/api/envelopes";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { pageLimit } from "@/lib/api/pagination";
import { revalidateStatusReportPaths, runStatusReportMutation, statusReportRouteError } from "@/lib/api/status-report-http";
import { createStatusReport, listStatusReportSummaries, parseStatusReportListQuery, recoverCreatedStatusReport } from "@/lib/api/status-reports";

export async function GET(request: Request) {
  const context = await authorize(request, { scope: "reports:read" });
  if (isApiResponse(context)) return context;
  const search = new URL(request.url).searchParams;
  const limit = pageLimit(search.get("limit"));
  if (!limit) return apiError(context.requestId, 400, "INVALID_LIMIT", "Limit must be an integer from 1 to 100");
  try {
    const query = parseStatusReportListQuery({
      state: search.get("state"),
      type: search.get("type"),
      cursor: search.get("cursor"),
    });
    // List-shaped rows: counts + latest status/publishedAt, no markdown bodies.
    const page = await listStatusReportSummaries({ ...query, limit });
    return apiJson(listEnvelope("StatusReportList", page.data, context.requestId, page.nextCursor));
  } catch (error) {
    return statusReportRouteError(error, context.requestId);
  }
}

export async function POST(request: Request) {
  const context = await authorize(request, { scope: "reports:write" });
  if (isApiResponse(context)) return context;
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    return statusReportRouteError(error, context.requestId);
  }
  return runStatusReportMutation({
    request,
    context,
    routeKey: "/api/v1/status-reports",
    body,
    // Recover by the id pinned to this operation rather than rerunning
    // work() with a fresh random id, which would insert a duplicate report.
    recover: async ({ operationId }) => {
      const report = await recoverCreatedStatusReport(operationId);
      if (!report) return null;
      // The crash this recovers from may have landed between the insert
      // committing and revalidation running, so ISR pages must be refreshed
      // here too, same as the normal work() path.
      await revalidateStatusReportPaths(report);
      return { status: 201, kind: "StatusReport", data: report };
    },
    work: async ({ operationId }) => {
      const report = await createStatusReport(body, { reportId: operationId });
      await revalidateStatusReportPaths(report);
      return { status: 201, kind: "StatusReport", data: report };
    },
  });
}
