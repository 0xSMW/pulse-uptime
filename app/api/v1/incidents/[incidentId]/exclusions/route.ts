import { apiError } from "@/lib/api/envelopes"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { isUuid } from "@/lib/ids/uuid"
import { applyIncidentExclusion } from "@/lib/incidents/exclusions"
import { applySchema, exclusionError, runExclusionMutation } from "./http"

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
    const body = applySchema.safeParse(await request.json())
    if (!(isUuid(incidentId) && body.success)) {
      return apiError(
        context.requestId,
        400,
        "INVALID_REQUEST",
        "Enter a reason and preview the interval"
      )
    }
    return runExclusionMutation(
      request,
      context,
      body.data,
      (tx, operationId) =>
        applyIncidentExclusion(
          incidentId,
          body.data,
          context.principalKey,
          operationId,
          tx
        ),
      201
    )
  } catch (error) {
    return exclusionError(error, context.requestId)
  }
}
