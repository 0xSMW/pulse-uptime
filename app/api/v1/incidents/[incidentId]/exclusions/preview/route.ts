import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { isUuid } from "@/lib/ids/uuid"
import { previewIncidentExclusion } from "@/lib/incidents/exclusions"
import { exclusionError, rangeSchema } from "../http"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ incidentId: string }> }
) {
  const context = await authorize(request, { scope: "monitors:write" })
  if (isApiResponse(context)) {
    return context
  }
  try {
    const { incidentId } = await params
    const body = rangeSchema.safeParse(await request.json())
    if (!(isUuid(incidentId) && body.success)) {
      return apiError(
        context.requestId,
        400,
        "INVALID_REQUEST",
        "Choose a valid incident and interval"
      )
    }
    return apiJson(
      objectEnvelope(
        "IncidentExclusionPreview",
        await previewIncidentExclusion(incidentId, body.data),
        context.requestId
      )
    )
  } catch (error) {
    return exclusionError(error, context.requestId)
  }
}
