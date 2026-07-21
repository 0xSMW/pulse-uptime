import { apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError } from "@/lib/api/route"
import { listCatalog } from "@/lib/dependencies/service"

export async function GET(request: Request) {
  const context = await authorize(request, { scope: "dependencies:read" })
  if (isApiResponse(context)) {
    return context
  }
  try {
    const categories = await listCatalog()
    return apiJson(
      objectEnvelope("DependencyCatalog", { categories }, context.requestId)
    )
  } catch (error) {
    return routeError(error, context.requestId)
  }
}
