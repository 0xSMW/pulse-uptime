import { authorize, isApiResponse } from "@/lib/api/middleware";
import { runStatusReportMutation } from "@/lib/api/status-report-http";
import { promoteIncident, recoverPromotedReport } from "@/lib/api/status-reports";

/**
 * Promotes an auto-detected incident to a DRAFT status report. Requires
 * reports:write since it creates a report. The incidents namespace is just its
 * address. Promotion is idempotent through the partial unique index on
 * originIncidentId, so no public revalidation is needed (drafts are invisible).
 */
export async function POST(request: Request, { params }: { params: Promise<{ incidentId: string }> }) {
  const context = await authorize(request, { scope: "reports:write" });
  if (isApiResponse(context)) return context;
  const incidentId = (await params).incidentId;
  return runStatusReportMutation({
    request,
    context,
    routeKey: `/api/v1/incidents/${incidentId}/promote`,
    body: {},
    // created vs. existing is recoverable via the pinned id: promoteIncident
    // pins its new report's id to the idempotency operationId, and a stale
    // reclaim reuses the SAME record id, so a recovered report whose id
    // equals THIS retry's operationId proves this crashed attempt inserted
    // it (201). Any other id means a different operation created it: a
    // concurrent promote that won the race, or one that already completed
    // (200).

    // No revalidateStatusReportPaths call here or in work() below: promotion
    // always creates a DRAFT (publishedAt: null), which is invisible on every
    // public route, so there is nothing to revalidate. The work() path below
    // never revalidates either, for the same reason.
    recover: async ({ operationId }) => {
      const recovered = await recoverPromotedReport(incidentId);
      if (!recovered) return null;
      return { status: recovered.id === operationId ? 201 : 200, kind: "StatusReport", data: recovered };
    },
    work: async ({ operationId }) => {
      const { report, created } = await promoteIncident(incidentId, { reportId: operationId });
      return { status: created ? 201 : 200, kind: "StatusReport", data: report };
    },
  });
}
