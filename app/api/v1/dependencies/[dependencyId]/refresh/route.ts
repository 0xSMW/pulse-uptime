import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { routeError } from "@/lib/api/route";
import { DependencyApiError, refreshDependency } from "@/lib/dependencies/service";

// Only sets the source's next_poll_at to now; the dependency cron does the
// actual fetch. Never fetches inline, so the SSRF surface stays in the cron
// and this route stays fast, per Docs/DEPENDENCY-MONITORING.md decision 9.
export async function POST(request: Request, { params }: { params: Promise<{ dependencyId: string }> }) {
  const context = await authorize(request, { scope: "dependencies:write" });
  if (isApiResponse(context)) return context;
  const dependencyId = (await params).dependencyId;
  try {
    const result = await executeIdempotent({ request, principalKey: context.principalKey, routeKey: `/api/v1/dependencies/${dependencyId}/refresh`, body: {},
      work: async () => ({ status: 202, body: objectEnvelope("DependencyRefresh", await refreshDependency(dependencyId), context.requestId) }),
    });
    return apiJson(result.body, { status: result.status });
  } catch (error) {
    if (error instanceof DependencyApiError) return apiError(context.requestId, error.code === "DEPENDENCY_NOT_FOUND" ? 404 : 400, error.code, error.message, error.details);
    return routeError(error, context.requestId);
  }
}
