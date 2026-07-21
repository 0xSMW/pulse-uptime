import { dependencyError } from "@/lib/api/dependency-http"
import { apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { executeIdempotent } from "@/lib/api/idempotency"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError } from "@/lib/api/route"
import { retryDependencyBackfill } from "@/lib/dependencies/service"

// Re-runs install-time incident backfill for a dependency whose add-time scan
// failed and was marked. The scan is anchored to the dependency's createdAt so
// it reproduces the same matches the add would have created. On success the
// backfill-failed mark clears and the refreshed detail is returned. The match
// writes and the cleared mark commit in one transaction with the idempotency
// record, so a crash before completion leaves nothing committed and a replay
// reruns cleanly. The scan is idempotent (matches insert ON CONFLICT DO
// NOTHING), so this endpoint is safe to call regardless of whether the mark is
// set: on an unmarked dependency it re-runs the scan as a no-op and clears an
// already-null mark.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ dependencyId: string }> }
) {
  const context = await authorize(request, { scope: "dependencies:write" })
  if (isApiResponse(context)) {
    return context
  }
  const dependencyId = (await params).dependencyId
  try {
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: `/api/v1/dependencies/${dependencyId}/backfill`,
      body: {},
      mode: "atomic",
      work: async (tx) => ({
        status: 200,
        body: objectEnvelope(
          "Dependency",
          await retryDependencyBackfill(dependencyId, {}, tx),
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
