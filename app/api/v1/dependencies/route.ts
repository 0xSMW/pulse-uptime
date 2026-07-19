import { z } from "zod";

import { apiError, apiJson, listEnvelope, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { routeError } from "@/lib/api/route";
import { DependencyApiError, installDependency, listDependencies, recoverInstalledDependency } from "@/lib/dependencies/service";

const createSchema = z.object({
  presetId: z.string().min(1),
  scopeId: z.string().min(1).optional(),
  notificationsEnabled: z.boolean().optional(),
}).strict();

function dependencyErrorStatus(code: DependencyApiError["code"]): number {
  if (code === "DEPENDENCY_NOT_FOUND") return 404;
  if (code === "DEPENDENCY_EXISTS") return 409;
  return 400;
}

function dependencyError(error: unknown, requestId: string): Response | null {
  if (error instanceof DependencyApiError) return apiError(requestId, dependencyErrorStatus(error.code), error.code, error.message, error.details);
  if (error instanceof z.ZodError) return apiError(requestId, 400, "INVALID_REQUEST", "Dependency request is invalid", { issues: error.issues });
  return null;
}

export async function GET(request: Request) {
  const context = await authorize(request, { scope: "dependencies:read" });
  if (isApiResponse(context)) return context;
  try {
    const result = await listDependencies();
    return apiJson(listEnvelope("DependencyList", result, context.requestId, null));
  } catch (error) {
    return dependencyError(error, context.requestId) ?? routeError(error, context.requestId);
  }
}

export async function POST(request: Request) {
  const context = await authorize(request, { scope: "dependencies:write" });
  if (isApiResponse(context)) return context;
  try {
    const body = await request.json();
    const parsed = createSchema.parse(body);
    const result = await executeIdempotent({ request, principalKey: context.principalKey, routeKey: "/api/v1/dependencies", body,
      recover: async ({ operationId }) => {
        const dependency = await recoverInstalledDependency(operationId);
        return dependency ? { status: 201, body: objectEnvelope("Dependency", dependency, context.requestId) } : null;
      },
      rerunAfterRecoveryMiss: false,
      work: async ({ operationId }) => ({
        status: 201,
        body: objectEnvelope("Dependency", await installDependency(parsed, { dependencyId: operationId }), context.requestId),
      }),
    });
    return apiJson(result.body, { status: result.status });
  } catch (error) {
    return dependencyError(error, context.requestId) ?? routeError(error, context.requestId);
  }
}
