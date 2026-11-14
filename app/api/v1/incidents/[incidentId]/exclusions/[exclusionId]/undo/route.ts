import { z } from "zod"
import { apiError } from "@/lib/api/envelopes"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { isUuid } from "@/lib/ids/uuid"
import { undoIncidentExclusion } from "@/lib/incidents/exclusions"
import { exclusionError, runExclusionMutation } from "../../http"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ incidentId: string; exclusionId: string }> }
) {
  const context = await authorize(request, { scope: "monitors:write" })
  if (isApiResponse(context)) {
    return context
  }
  try {
    const { incidentId, exclusionId } = await params
    const body = z
      .object({})
      .strict()
      .safeParse(await request.json())
    if (!(isUuid(incidentId) && isUuid(exclusionId) && body.success)) {
      return apiError(
        context.requestId,
        400,
        "INVALID_REQUEST",
        "Choose a valid exclusion"
      )
    }
    return runExclusionMutation(
      request,
      context,
      body.data,
      (tx) =>
        undoIncidentExclusion(
          incidentId,
          exclusionId,
          context.principalKey,
          tx
        ),
      200
    )
  } catch (error) {
    return exclusionError(error, context.requestId)
  }
}
