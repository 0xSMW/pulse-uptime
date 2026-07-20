import { apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { deleteGroup, GroupApiError, updateGroup } from "@/lib/api/groups";
import { groupError, storedGroupError } from "@/lib/api/group-http";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { routeError } from "@/lib/api/route";
type Params = { params: Promise<{ groupId: string }> };
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
