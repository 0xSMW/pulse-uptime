import { dependencyError } from "@/lib/api/dependency-http"
import { apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { executeIdempotent } from "@/lib/api/idempotency"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError, success } from "@/lib/api/route"
import {
  patchDependency,
  removeDependency,
  requireDependencyDetail,
} from "@/lib/dependencies/service"

interface Params {
  params: Promise<{ dependencyId: string }>
}

// A 204 response must never carry a body. The idempotency store still keeps
// a small JSON body internally for replay bookkeeping; only the outgoing
// HTTP response drops it.
function noContent(): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Pulse-API-Version": "v1",
  })
  return new Response(null, { status: 204, headers })
}

export async function GET(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "dependencies:read" })
  if (isApiResponse(context)) {
    return context
  }
  try {
    return success(
      "Dependency",
      await requireDependencyDetail((await params).dependencyId),
      context.requestId
    )
  } catch (error) {
    return (
      dependencyError(error, context.requestId) ??
      routeError(error, context.requestId)
    )
  }
}

export async function PATCH(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "dependencies:write" })
  if (isApiResponse(context)) {
    return context
  }
  const dependencyId = (await params).dependencyId
  try {
    const body = await request.json()
    // The patch and its idempotency record commit in one transaction, so a
    // crash before completion leaves nothing committed and a replay reruns
    // cleanly rather than replaying against a half-applied change.
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: `/api/v1/dependencies/${dependencyId}`,
      body,
      mode: "atomic",
      work: async (tx) => ({
        status: 200,
        body: objectEnvelope(
          "Dependency",
          await patchDependency(dependencyId, body, {}, tx),
          context.requestId
        ),
      }),
    })
    return apiJson(result.body, { status: result.status })
  } catch (error) {
    return (
      dependencyError(error, context.requestId) ??
      routeError(error, context.requestId)
    )
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "dependencies:write" })
  if (isApiResponse(context)) {
    return context
  }
  const dependencyId = (await params).dependencyId
  try {
    // The soft removal and its idempotency record commit in one transaction.
    // If the process dies before completion, the removal rolls back with the
    // still-running record, so a reclaimed replay reruns and removes the row,
    // returning 204. If both committed, the replay replays the stored 204.
    // Either way an already-removed dependency never surfaces a 404 to a
    // replay of the request that removed it.
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: `/api/v1/dependencies/${dependencyId}`,
      body: {},
      mode: "atomic",
      work: async (tx) => ({
        status: 204,
        body: await removeDependency(dependencyId, {}, tx),
      }),
    })
    return result.status === 204
      ? noContent()
      : apiJson(result.body, { status: result.status })
  } catch (error) {
    return (
      dependencyError(error, context.requestId) ??
      routeError(error, context.requestId)
    )
  }
}
