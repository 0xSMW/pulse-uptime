import { z } from "zod";

import { apiError, apiJson, errorEnvelope, listEnvelope, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent, type StoredResponse } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { routeError } from "@/lib/api/route";
import { DependencyApiError, installDependency, listDependencies } from "@/lib/dependencies/service";

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

// Turns a business error thrown inside the idempotency transaction into a
// stored response so the record commits that outcome instead of rolling back,
// mirroring the monitors route. A duplicate install stores a clean 409.
function storedDependencyError(error: unknown, requestId: string): StoredResponse | null {
  if (!(error instanceof DependencyApiError)) return null;
  return { status: dependencyErrorStatus(error.code), body: errorEnvelope(error.code, error.message, requestId, error.details) };
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
      work: async ({ operationId, transaction }) => transaction(async (tx) => {
        try {
          return { status: 201, body: objectEnvelope("Dependency", await installDependency(parsed, { dependencyId: operationId }, tx), context.requestId) };
        } catch (error) {
          const stored = storedDependencyError(error, context.requestId);
          if (stored) return stored;
          throw error;
        }
      }),
    });
    return apiJson(result.body, { status: result.status });
  } catch (error) {
    return dependencyError(error, context.requestId) ?? routeError(error, context.requestId);
  }
}
