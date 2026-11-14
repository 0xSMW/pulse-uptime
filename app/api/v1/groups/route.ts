import { runAtomicMutation } from "@/lib/api/atomic-mutation"
import { apiJson, listEnvelope } from "@/lib/api/envelopes"
import { groupError, storedGroupError } from "@/lib/api/group-http"
import { createGroup, GroupApiError, listGroups } from "@/lib/api/groups"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError } from "@/lib/api/route"

export async function GET(request: Request) {
  const context = await authorize(request, { scope: "monitors:read" })
  if (isApiResponse(context)) {
    return context
  }
  try {
    return apiJson(
      listEnvelope("GroupList", await listGroups(), context.requestId, null)
    )
  } catch (error) {
    return (
      groupError(error, context.requestId) ??
      routeError(error, context.requestId)
    )
  }
}

export async function POST(request: Request) {
  const context = await authorize(request, { scope: "monitors:write" })
  if (isApiResponse(context)) {
    return context
  }
  try {
    const body = await request.json()
    return runAtomicMutation({
      request,
      context,
      routeKey: "/api/v1/groups",
      body,
      work: async (tx) => ({
        status: 201,
        kind: "Group",
        data: await createGroup(body, context.principalKey, tx),
      }),
      storedError: (error, requestId) =>
        error instanceof GroupApiError
          ? storedGroupError(error, requestId)
          : null,
      mapError: groupError,
    })
  } catch (error) {
    return (
      groupError(error, context.requestId) ??
      routeError(error, context.requestId)
    )
  }
}
