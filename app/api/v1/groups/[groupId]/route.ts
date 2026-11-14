import { runAtomicMutation } from "@/lib/api/atomic-mutation"
import { groupError, storedGroupError } from "@/lib/api/group-http"
import { deleteGroup, GroupApiError, updateGroup } from "@/lib/api/groups"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError } from "@/lib/api/route"

interface Params {
  params: Promise<{ groupId: string }>
}
export async function PATCH(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "monitors:write" })
  if (isApiResponse(context)) {
    return context
  }
  const id = (await params).groupId
  try {
    const body = await request.json()
    return runAtomicMutation({
      request,
      context,
      routeKey: `/api/v1/groups/${id}`,
      body,
      work: async (tx) => ({
        status: 200,
        kind: "Group",
        data: await updateGroup(id, body, context.principalKey, tx),
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
export async function DELETE(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "monitors:write" })
  if (isApiResponse(context)) {
    return context
  }
  const id = (await params).groupId
  try {
    return runAtomicMutation({
      request,
      context,
      routeKey: `/api/v1/groups/${id}`,
      body: {},
      work: async (tx) => ({
        status: 200,
        kind: "GroupDeletion",
        data: await deleteGroup(id, context.principalKey, tx),
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
