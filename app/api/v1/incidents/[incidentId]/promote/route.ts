import { apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { statusReportRouteError } from "@/lib/api/status-report-http";
import { promoteIncident } from "@/lib/api/status-reports";

/**
 * Promotes an auto-detected incident to a DRAFT status report. Requires
 * reports:write — it creates a report; the incidents namespace is just its
 * address. Promotion is idempotent through the partial unique index on
 * originIncidentId, so no public revalidation is needed (drafts are invisible).
 */
export async function POST(request: Request, { params }: { params: Promise<{ incidentId: string }> }) {
  const context = await authorize(request, { scope: "reports:write" });
  if (isApiResponse(context)) return context;
  const incidentId = (await params).incidentId;
  try {
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: `/api/v1/incidents/${incidentId}/promote`,
      body: {},
      work: async () => {
        const { report, created } = await promoteIncident(incidentId);
        return { status: created ? 201 : 200, body: objectEnvelope("StatusReport", report, context.requestId) };
      },
    });
    return apiJson(result.body, { status: result.status });
  } catch (error) {
    return statusReportRouteError(error, context.requestId);
  }
}
