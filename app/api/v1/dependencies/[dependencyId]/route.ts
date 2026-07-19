import { z } from "zod";

import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { routeError, success } from "@/lib/api/route";
import { DependencyApiError, getDependencyDetail, patchDependency, removeDependency } from "@/lib/dependencies/service";

type Params = { params: Promise<{ dependencyId: string }> };

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

// A 204 response must never carry a body. The idempotency store still keeps
// a small JSON body internally for replay bookkeeping; only the outgoing
// HTTP response drops it.
function noContent(): Response {
  const headers = new Headers({ "Cache-Control": "no-store", "X-Pulse-API-Version": "v1" });
  return new Response(null, { status: 204, headers });
}

export async function GET(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "dependencies:read" });
  if (isApiResponse(context)) return context;
  try {
    return success("Dependency", await getDependencyDetail((await params).dependencyId), context.requestId);
  } catch (error) {
    return dependencyError(error, context.requestId) ?? routeError(error, context.requestId);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "dependencies:write" });
  if (isApiResponse(context)) return context;
  const dependencyId = (await params).dependencyId;
  try {
    const body = await request.json();
    const result = await executeIdempotent({ request, principalKey: context.principalKey, routeKey: `/api/v1/dependencies/${dependencyId}`, body,
      work: async () => ({ status: 200, body: objectEnvelope("Dependency", await patchDependency(dependencyId, body), context.requestId) }),
    });
    return apiJson(result.body, { status: result.status });
  } catch (error) {
    return dependencyError(error, context.requestId) ?? routeError(error, context.requestId);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "dependencies:write" });
  if (isApiResponse(context)) return context;
  const dependencyId = (await params).dependencyId;
  try {
    const result = await executeIdempotent({ request, principalKey: context.principalKey, routeKey: `/api/v1/dependencies/${dependencyId}`, body: {},
      work: async () => ({ status: 204, body: await removeDependency(dependencyId) }),
    });
    return result.status === 204 ? noContent() : apiJson(result.body, { status: result.status });
  } catch (error) {
    return dependencyError(error, context.requestId) ?? routeError(error, context.requestId);
  }
}
