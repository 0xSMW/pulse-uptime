import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { routeError } from "@/lib/api/route";
import { revokeApiToken } from "@/lib/api/token-service";

export async function DELETE(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const context = await authorize(request, { scope: "tokens:manage" });
  if (isApiResponse(context)) return context;
  const { tokenId } = await params;
  if (!isUuid(tokenId)) return apiError(context.requestId, 400, "INVALID_TOKEN", "Token ID is invalid");
  try {
    const result = await executeIdempotent<{ token: { id: string; revokedAt: string | null } | null }>({
      request,
      principalKey: context.principalKey,
      routeKey: "token-revoke",
      body: { tokenId },
      work: async () => {
        const token = await revokeApiToken(tokenId);
        if (!token) return { status: 404, body: { token: null } };
        return { status: 200, body: { token: { id: token.id, revokedAt: token.revokedAt?.toISOString() ?? null } } };
      },
    });
    if (!result.body.token) return apiError(context.requestId, 404, "TOKEN_NOT_FOUND", "Token was not found");
    return apiJson(objectEnvelope("TokenRevocation", result.body.token, context.requestId), { status: result.status });
  } catch (error) {
    return routeError(error, context.requestId);
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
