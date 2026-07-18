import { apiError, apiJson, listEnvelope, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { pageLimit } from "@/lib/api/pagination";
import { revalidateStatusReportPaths, statusReportRouteError, storedStatusReportError } from "@/lib/api/status-report-http";
import {
  createStatusReport,
  listStatusReportSummaries,
  parseStatusReportListQuery,
  recoverCreatedStatusReport,
  StatusReportError,
} from "@/lib/api/status-reports";

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
  try {
    const body = await request.json();
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: "/api/v1/status-reports",
      body,
      // A retry after a stale-record reclaim means a prior attempt may have
      // already inserted the report before crashing; recover it by the id we
      // pin to the operation instead of re-running the callback with a fresh
      // random id (which would create a duplicate report).
      recover: async ({ operationId }) => {
        const report = await recoverCreatedStatusReport(operationId);
        return report ? { status: 201, body: objectEnvelope("StatusReport", report, context.requestId) } : null;
      },
      rerunAfterRecoveryMiss: false,
      work: async ({ operationId }) => {
        try {
          const report = await createStatusReport(body, { reportId: operationId });
          await revalidateStatusReportPaths(report);
          return { status: 201, body: objectEnvelope("StatusReport", report, context.requestId) };
        } catch (error) {
          // VALIDATION_ERROR is a deterministic outcome of the request body,
          // not proof this operation ever ran — recorded here rather than
          // thrown past executeIdempotent so a retry with the same key
          // replays the recorded 400 verbatim via the ordinary
          // completed-record path instead of leaving the record stuck
          // "running" until a stale reclaim's recover callback (which can't
          // tell "genuinely never ran" from "validation failed") forces a
          // REQUEST_IN_PROGRESS 409 demanding a new key.
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
