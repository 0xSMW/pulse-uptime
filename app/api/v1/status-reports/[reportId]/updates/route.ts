import { authorize, isApiResponse } from "@/lib/api/middleware"
import {
  collectStatusReportPaths,
  runStatusReportMutation,
  statusReportRouteError,
} from "@/lib/api/status-report-http"
import {
  addReportUpdate,
  createDatabaseStatusReportsStore,
} from "@/lib/api/status-reports"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ reportId: string }> }
) {
  const context = await authorize(request, { scope: "reports:write" })
  if (isApiResponse(context)) {
    return context
  }
  const reportId = (await params).reportId
  let body: unknown
  try {
    body = await request.json()
  } catch (error) {
    return statusReportRouteError(error, context.requestId)
  }
  return runStatusReportMutation({
    request,
    context,
    routeKey: `/api/v1/status-reports/${reportId}/updates`,
    body,
    work: async (tx, { operationId }) => {
      const store = createDatabaseStatusReportsStore(tx)
      const report = await addReportUpdate(reportId, body, {
        updateId: operationId,
        store,
      })
      const revalidatePaths = await collectStatusReportPaths(report, [], store)
      return {
        status: 201,
        kind: "StatusReport",
        data: report,
        revalidatePaths,
      }
    },
  })
}
