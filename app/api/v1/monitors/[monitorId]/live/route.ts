import { apiError } from "@/lib/api/envelopes"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError, success } from "@/lib/api/route"
import { hasScope } from "@/lib/api/scopes"
import { findMonitorLive } from "@/lib/reporting/queries/monitors"

// Live summary for the open monitor page. The dashboard session resolves as a
// human principal through authorize, the same path the other monitor reads use.
// The route scope is monitors:read, so the incident fields are included only
// when the principal also holds incidents:read, matching the incident APIs.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ monitorId: string }> }
) {
  const context = await authorize(request, { scope: "monitors:read" })
  if (isApiResponse(context)) {
    return context
  }
  try {
    const includeIncidents = hasScope(context.principal, "incidents:read")
    const live = await findMonitorLive((await params).monitorId, {
      includeIncidents,
    })
    if (!live) {
      return apiError(
        context.requestId,
        404,
        "MONITOR_NOT_FOUND",
        "Monitor not found"
      )
    }
    return success("MonitorLive", live, context.requestId)
  } catch (error) {
    return routeError(error, context.requestId)
  }
}
