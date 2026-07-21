import { apiError, apiJson, listEnvelope } from "@/lib/api/envelopes"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import {
  OperationalInputError,
  operationalService,
  parseIncidentCursor,
} from "@/lib/api/operational-service"
import { pageLimit } from "@/lib/api/pagination"

export async function GET(request: Request) {
  const context = await authorize(request, { scope: "incidents:read" })
  if (isApiResponse(context)) {
    return context
  }
  const url = new URL(request.url)
  const limit = pageLimit(url.searchParams.get("limit"))
  if (!limit) {
    return apiError(
      context.requestId,
      400,
      "INVALID_LIMIT",
      "Limit must be an integer from 1 to 100"
    )
  }
  try {
    const page = await operationalService.listIncidents({
      cursor: parseIncidentCursor(url.searchParams.get("cursor")),
      limit,
    })
    return apiJson(
      listEnvelope(
        "IncidentList",
        page.data,
        context.requestId,
        page.nextCursor
      )
    )
  } catch (error) {
    if (error instanceof OperationalInputError) {
      return apiError(context.requestId, 400, error.code, error.message)
    }
    return apiError(
      context.requestId,
      500,
      "INTERNAL_ERROR",
      "The request could not be completed"
    )
  }
}
