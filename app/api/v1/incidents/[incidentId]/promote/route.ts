import { sourceFromPrincipalKey, trackEvent } from "@/lib/analytics-server"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { runStatusReportMutation } from "@/lib/api/status-report-http"
import {
  createDatabaseStatusReportsStore,
  promoteIncident,
} from "@/lib/api/status-reports"

/**
 * Promotes an auto-detected incident to a DRAFT status report. Requires
 * reports:write since it creates a report. The incidents namespace is just its
 * address. Promotion is idempotent through the partial unique index on
 * originIncidentId, so no public revalidation is needed (drafts are invisible).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ incidentId: string }> }
) {
  const context = await authorize(request, { scope: "reports:write" })
  if (isApiResponse(context)) {
    return context
  }
  const incidentId = (await params).incidentId
  return runStatusReportMutation({
    request,
    context,
    routeKey: `/api/v1/incidents/${incidentId}/promote`,
    body: {},
    // No revalidatePaths from work() below: promotion always
    // creates a DRAFT (publishedAt: null), which is invisible on every
    // public route, so there is nothing to revalidate.
    work: async (tx, { operationId }) => {
      const { report, created } = await promoteIncident(incidentId, {
        reportId: operationId,
        store: createDatabaseStatusReportsStore(tx),
      })
      if (created) {
        trackEvent("Incident Promoted", {
          source: sourceFromPrincipalKey(context.principalKey),
        })
      }
      return { status: created ? 201 : 200, kind: "StatusReport", data: report }
    },
  })
}
