import { apiJson, objectEnvelope, requestIdFrom } from "@/lib/api/envelopes";
import { resolveRevokedCliRevokeReplay, revokeCliInstallation } from "@/lib/api/device-authorization";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { routeError } from "@/lib/api/route";

export async function POST(request: Request) {
  const authorized = await authorize(request);
  const replay = isApiResponse(authorized) ? await resolveRevokedCliRevokeReplay(request) : null;
  if (isApiResponse(authorized) && !replay) return authorized;
  const context = isApiResponse(authorized)
    ? { principal: { type: "cli_session", id: replay!.id }, principalKey: replay!.principalKey, requestId: requestIdFrom(request) }
    : authorized;
  try {
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: "cli-session-revoke",
      body: {},
      work: async ({ transaction }) => transaction(async (tx) => ({ status: 200, body: { revoked: await revokeCliInstallation(context.principal, new Date(), tx) } })),
    });
    return apiJson(objectEnvelope("CliSessionRevocation", result.body, context.requestId), { status: result.status });
  } catch (error) {
    return routeError(error, context.requestId);
  }
}
