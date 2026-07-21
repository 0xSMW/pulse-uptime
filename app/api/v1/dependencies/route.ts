import { z } from "zod"
import {
  dependencyError,
  storedDependencyError,
} from "@/lib/api/dependency-http"
import { apiJson, listEnvelope, objectEnvelope } from "@/lib/api/envelopes"
import { executeIdempotent } from "@/lib/api/idempotency"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError } from "@/lib/api/route"
import { addDependency, listDependencies } from "@/lib/dependencies/service"

const createSchema = z
  .object({
    presetId: z.string().min(1),
    scopeId: z.string().min(1).optional(),
    notificationsEnabled: z.boolean().optional(),
  })
  .strict()

export async function GET(request: Request) {
  const context = await authorize(request, { scope: "dependencies:read" })
  if (isApiResponse(context)) {
    return context
  }
  try {
    const result = await listDependencies()
    return apiJson(
      listEnvelope("DependencyList", result, context.requestId, null)
    )
  } catch (error) {
    return (
      dependencyError(error, context.requestId) ??
      routeError(error, context.requestId)
    )
  }
}

export async function POST(request: Request) {
  const context = await authorize(request, { scope: "dependencies:write" })
  if (isApiResponse(context)) {
    return context
  }
  try {
    const body = await request.json()
    const parsed = createSchema.parse(body)
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: "/api/v1/dependencies",
      body,
      mode: "atomic",
      work: async (tx, { operationId }) => {
        try {
          return {
            status: 201,
            body: objectEnvelope(
              "Dependency",
              await addDependency(parsed, { dependencyId: operationId }, tx),
              context.requestId
            ),
          }
        } catch (error) {
          const stored = storedDependencyError(error, context.requestId)
          if (stored) {
            return stored
          }
          throw error
        }
      },
    })
    return apiJson(result.body, { status: result.status })
  } catch (error) {
    return (
      dependencyError(error, context.requestId) ??
      routeError(error, context.requestId)
    )
  }
}
