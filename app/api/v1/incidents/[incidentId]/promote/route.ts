import { apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { statusReportRouteError, storedStatusReportError } from "@/lib/api/status-report-http";
import { promoteIncident, StatusReportError } from "@/lib/api/status-reports";

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
        try {
          const { report, created } = await promoteIncident(incidentId);
          return { status: created ? 201 : 200, body: objectEnvelope("StatusReport", report, context.requestId) };
        } catch (error) {
          // INCIDENT_NOT_FOUND is a deterministic outcome of the CURRENT
          // state, not proof this operation ever ran — recorded here rather
          // than thrown past executeIdempotent (finding: a thrown 404 left
          // the idempotency record stuck "running" until a stale reclaim's
          // recover callback — there isn't one here — or the 5-minute stale
          // window forced a REQUEST_IN_PROGRESS 409 on every retry in the
          // meantime instead of a clean, replayable 404). A retry with the
          // same key now replays the recorded 404 (or 201/200) verbatim via
          // the ordinary completed-record path.
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
