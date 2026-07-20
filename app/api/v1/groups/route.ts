import { apiJson, listEnvelope, objectEnvelope } from "@/lib/api/envelopes";
import { createGroup, GroupApiError, listGroups } from "@/lib/api/groups";
import { groupError, storedGroupError } from "@/lib/api/group-http";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { routeError } from "@/lib/api/route";

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
      work: async ({ transaction }) => transaction(async (tx) => {
        try { return { status: 201, body: objectEnvelope("Group", await createGroup(body, context.principalKey, tx), context.requestId) }; }
        catch (error) { if (error instanceof GroupApiError) return storedGroupError(error, context.requestId); throw error; }
      }) });
    return apiJson(result.body, { status: result.status });
  } catch (error) { return groupError(error, context.requestId) ?? routeError(error, context.requestId); }
}
