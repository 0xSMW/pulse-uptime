import { apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { statusReportRouteError, storedStatusReportError } from "@/lib/api/status-report-http";
import { promoteIncident, recoverPromotedReport, StatusReportError } from "@/lib/api/status-reports";

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
      // A retry after a stale-record reclaim may be replaying a promote that
      // already committed before a crash. promoteIncident is already safe to
      // rerun outright — insertPromotedReport's conflict path on the partial
      // unique index on originIncidentId just returns the existing report —
      // but recovering lets the retry short-circuit at a single point lookup
      // instead of re-validating the incident and re-serializing fresh
      // values on every replay. Returns the existing report for this
      // incident, or null when no report exists yet so work() reruns to
      // create it.
      //
      // created vs. existing is recoverable via the pinned id: promoteIncident
      // pins its new report's id to the idempotency operationId (mirroring
      // createStatusReport), and claimStale reuses the SAME record id across a
      // stale reclaim. So if the recovered report's id equals THIS retry's
      // operationId, this exact crashed attempt is the one that inserted it
      // (201); any other id means a different operation created it — a
      // concurrent promote that won the race, or one that already completed
      // (200).
      recover: async ({ operationId }) => {
        const recovered = await recoverPromotedReport(incidentId);
        if (!recovered) return null;
        const status = recovered.id === operationId ? 201 : 200;
        return { status, body: objectEnvelope("StatusReport", recovered, context.requestId) };
      },
      rerunAfterRecoveryMiss: false,
      work: async ({ operationId }) => {
        try {
          const { report, created } = await promoteIncident(incidentId, { reportId: operationId });
          return { status: created ? 201 : 200, body: objectEnvelope("StatusReport", report, context.requestId) };
        } catch (error) {
          // INCIDENT_NOT_FOUND is a deterministic outcome of the CURRENT
          // state, not proof this operation ever ran — recorded here rather
          // than thrown past executeIdempotent (finding: a thrown 404 left
          // the idempotency record stuck "running" until a stale reclaim
          // either forced a REQUEST_IN_PROGRESS 409 on every retry within the
          // 5-minute stale window, or — before recover existed — reran into
          // the same deterministic failure repeatedly instead of a clean,
          // replayable 404; recover above only ever returns non-null when a
          // report already exists for this incident, so a genuinely unknown
          // incident always falls through to here). A retry with the same
          // key now replays the recorded 404 (or 201/200) verbatim via the
          // ordinary completed-record path.
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
