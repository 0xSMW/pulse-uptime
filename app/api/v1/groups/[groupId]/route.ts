import { z } from "zod";
import { apiError, apiJson, errorEnvelope, objectEnvelope } from "@/lib/api/envelopes";
import { deleteGroup, GroupApiError, updateGroup } from "@/lib/api/groups";
import { executeIdempotent, type StoredResponse } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { routeError } from "@/lib/api/route";
import { ConfigMutationError } from "@/lib/api/config-mutation";
import { ConfigSizeError } from "@/lib/config";
type Params = { params: Promise<{ groupId: string }> };
function groupErrorStatus(code: GroupApiError["code"]): number {
  return code === "GROUP_NOT_FOUND" ? 404 : 409;
}
function groupError(error: unknown, requestId: string): Response | null {
  if (error instanceof GroupApiError) return apiError(requestId, groupErrorStatus(error.code), error.code, error.message, error.details);
  if (error instanceof ConfigMutationError) return apiError(requestId, 503, error.code, error.message);
  if (error instanceof ConfigSizeError) return apiError(requestId, 400, error.code, error.message, { actualBytes: error.actualBytes, maximumBytes: error.maximumBytes });
  if (error instanceof z.ZodError) return apiError(requestId, 400, "INVALID_REQUEST", "Group request is invalid", { issues: error.issues }); return null;
}
// A GroupApiError from renameGroup/removeGroup is a real outcome of current
// config state, not evidence the mutation never ran: both validate and throw
// before nextConfig produces a new config, so the completion can commit
// alongside this stored error instead of leaving the record running for a
// stale-window retry to rerun against whatever state exists by then.
function storedGroupError(error: GroupApiError, requestId: string): StoredResponse {
  return { status: groupErrorStatus(error.code), body: errorEnvelope(error.code, error.message, requestId, error.details) };
}
export async function PATCH(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "monitors:write" }); if (isApiResponse(context)) return context;
  const id = (await params).groupId;
  try {
    const body = await request.json();
    const result = await executeIdempotent({ request, principalKey: context.principalKey, routeKey: `/api/v1/groups/${id}`, body, work: async ({ transaction }) => transaction(async (tx) => {
      try { return { status: 200, body: objectEnvelope("Group", await updateGroup(id, body, context.principalKey, tx), context.requestId) }; }
      catch (error) { if (error instanceof GroupApiError) return storedGroupError(error, context.requestId); throw error; }
    }) });
    return apiJson(result.body, { status: result.status });
  } catch (error) { return groupError(error, context.requestId) ?? routeError(error, context.requestId); }
}
export async function DELETE(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "monitors:write" }); if (isApiResponse(context)) return context;
  const id = (await params).groupId;
  try {
    const result = await executeIdempotent({ request, principalKey: context.principalKey, routeKey: `/api/v1/groups/${id}`, body: {}, work: async ({ transaction }) => transaction(async (tx) => {
      try { return { status: 200, body: objectEnvelope("GroupDeletion", await deleteGroup(id, context.principalKey, tx), context.requestId) }; }
      catch (error) { if (error instanceof GroupApiError) return storedGroupError(error, context.requestId); throw error; }
    }) });
    return apiJson(result.body, { status: result.status });
  } catch (error) { return groupError(error, context.requestId) ?? routeError(error, context.requestId); }
}
