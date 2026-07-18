import { z } from "zod";
import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { deleteGroup, GroupApiError, recoverDeletedGroup, recoverUpdatedGroup, updateGroup } from "@/lib/api/groups";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { routeError } from "@/lib/api/route";
import { ConfigMutationError } from "@/lib/api/config-mutation";
import { ConfigSizeError } from "@/lib/config";
type Params = { params: Promise<{ groupId: string }> };
function groupError(error: unknown, requestId: string): Response | null {
  if (error instanceof GroupApiError) return apiError(requestId, error.code === "GROUP_NOT_FOUND" ? 404 : 409, error.code, error.message, error.details);
  if (error instanceof ConfigMutationError) return apiError(requestId, 503, error.code, error.message);
  if (error instanceof ConfigSizeError) return apiError(requestId, 400, error.code, error.message, { actualBytes: error.actualBytes, maximumBytes: error.maximumBytes });
  if (error instanceof z.ZodError) return apiError(requestId, 400, "INVALID_REQUEST", "Group request is invalid", { issues: error.issues }); return null;
}
export async function PATCH(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "monitors:write" }); if (isApiResponse(context)) return context;
  const id = (await params).groupId;
  try { const body = await request.json(); const result = await executeIdempotent({ request, principalKey: context.principalKey, routeKey: `/api/v1/groups/${id}`, body, recover: async () => { const group = await recoverUpdatedGroup(id, body); return group ? { status: 200, body: objectEnvelope("Group", group, context.requestId) } : null; }, rerunAfterRecoveryMiss: false, work: async () => ({ status: 200, body: objectEnvelope("Group", await updateGroup(id, body, context.principalKey), context.requestId) }) }); return apiJson(result.body); }
  catch (error) { return groupError(error, context.requestId) ?? routeError(error, context.requestId); }
}
export async function DELETE(request: Request, { params }: Params) {
  const context = await authorize(request, { scope: "monitors:write" }); if (isApiResponse(context)) return context;
  const id = (await params).groupId;
  try { const result = await executeIdempotent({ request, principalKey: context.principalKey, routeKey: `/api/v1/groups/${id}`, body: {}, recover: async () => { const deletion = await recoverDeletedGroup(id); return deletion ? { status: 200, body: objectEnvelope("GroupDeletion", deletion, context.requestId) } : null; }, rerunAfterRecoveryMiss: false, work: async () => ({ status: 200, body: objectEnvelope("GroupDeletion", await deleteGroup(id, context.principalKey), context.requestId) }) }); return apiJson(result.body); }
  catch (error) { return groupError(error, context.requestId) ?? routeError(error, context.requestId); }
}
