import { z } from "zod";
import { apiError, apiJson, listEnvelope, objectEnvelope } from "@/lib/api/envelopes";
import { createGroup, GroupApiError, listGroups } from "@/lib/api/groups";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { routeError } from "@/lib/api/route";
import { ConfigMutationError } from "@/lib/api/config-mutation";
import { ConfigSizeError } from "@/lib/config";

function groupError(error: unknown, requestId: string): Response | null {
  if (error instanceof GroupApiError) return apiError(requestId, error.code === "GROUP_EXISTS" ? 409 : 400, error.code, error.message, error.details);
  if (error instanceof ConfigMutationError) return apiError(requestId, 503, error.code, error.message);
  if (error instanceof ConfigSizeError) return apiError(requestId, 400, error.code, error.message, { actualBytes: error.actualBytes, maximumBytes: error.maximumBytes });
  if (error instanceof z.ZodError) return apiError(requestId, 400, "INVALID_REQUEST", "Group request is invalid", { issues: error.issues });
  return null;
}

export async function GET(request: Request) {
  const context = await authorize(request, { scope: "monitors:read" }); if (isApiResponse(context)) return context;
  try { return apiJson(listEnvelope("GroupList", await listGroups(), context.requestId, null)); }
  catch (error) { return groupError(error, context.requestId) ?? routeError(error, context.requestId); }
}

export async function POST(request: Request) {
  const context = await authorize(request, { scope: "monitors:write" }); if (isApiResponse(context)) return context;
  try {
    const body = await request.json();
    const result = await executeIdempotent({ request, principalKey: context.principalKey, routeKey: "/api/v1/groups", body,
      work: async ({ transaction }) => transaction(async (tx) => ({ status: 201, body: objectEnvelope("Group", await createGroup(body, context.principalKey, tx), context.requestId) })) });
    return apiJson(result.body, { status: result.status });
  } catch (error) { return groupError(error, context.requestId) ?? routeError(error, context.requestId); }
}
