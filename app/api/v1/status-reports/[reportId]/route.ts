import { apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import {
  collectStatusReportPaths,
  runStatusReportMutation,
  statusReportRouteError,
} from "@/lib/api/status-report-http"
import {
  createDatabaseStatusReportsStore,
  deleteStatusReport,
  requireStatusReport,
  updateStatusReport,
} from "@/lib/api/status-reports"

type Params = { params: Promise<{ reportId: string }> }

export async function GET(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "reports:read" })
  if (isApiResponse(context)) {
    return context
  }
  try {
    const report = await requireStatusReport((await params).reportId)
    return apiJson(objectEnvelope("StatusReport", report, context.requestId))
  } catch (error) {
    return statusReportRouteError(error, context.requestId)
  }
}

export async function PATCH(request: Request, { params }: Params) {
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
    routeKey: `/api/v1/status-reports/${reportId}`,
    body,
    work: async (tx) => {
      const store = createDatabaseStatusReportsStore(tx)
      // Replacing the affected set can move the report between group pages.
      // Capture the pre-patch snapshot so the pages it leaves also refresh.
      const previous =
        body !== null && typeof body === "object" && "affected" in body
          ? await requireStatusReport(reportId, { store }).catch(() => null)
          : null
      const report = await updateStatusReport(reportId, body, { store })
      const revalidatePaths = await collectStatusReportPaths(
        report,
        previous?.affected ?? [],
        store
      )
      return {
        status: 200,
        kind: "StatusReport",
        data: report,
        revalidatePaths,
      }
    },
  })
}

export async function DELETE(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "reports:write" })
  if (isApiResponse(context)) {
    return context
  }
  const reportId = (await params).reportId
  return runStatusReportMutation({
    request,
    context,
    routeKey: `/api/v1/status-reports/${reportId}`,
    body: {},
    work: async (tx) => {
      const store = createDatabaseStatusReportsStore(tx)
      const report = await requireStatusReport(reportId, { store })
      await deleteStatusReport(reportId, { store })
      const revalidatePaths = await collectStatusReportPaths(report, [], store)
      return {
        status: 200,
        kind: "StatusReportDeleted",
        data: { id: reportId },
        revalidatePaths,
      }
    },
  })
}
