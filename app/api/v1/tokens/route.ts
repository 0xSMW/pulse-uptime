import { apiError, apiJson, listEnvelope, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent, requireIdempotencyKey } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { decodeCursor, encodeCursor, pageLimit } from "@/lib/api/pagination";
import { routeError } from "@/lib/api/route";
import { createApiToken, listApiTokens, TokenServiceError, validateTokenInput } from "@/lib/api/token-service";
import { credentialDerivationContext, deriveBearerToken } from "@/lib/api/tokens";

const TOKEN_CREATE_LIMIT = { routeKey: "token-create", limit: 10, windowSeconds: 60 * 60 };

export async function POST(request: Request) {
  const context = await authorize(request, { scope: "tokens:manage", rateLimit: TOKEN_CREATE_LIMIT });
  if (isApiResponse(context)) return context;
  try {
    const input = validateTokenInput(await request.json(), context.principal);
    const canonicalInput = { ...input, expiresAt: input.expiresAt.toISOString() };
    const idempotencyKey = requireIdempotencyKey(request);
    const result = await executeIdempotent<CreatedTokenData>({
      request,
      principalKey: context.principalKey,
      routeKey: "token-create",
      body: canonicalInput,
      work: async ({ operationId, transaction }) => transaction(async (tx) => {
        const credential = deriveBearerToken(credentialDerivationContext({
          kind: "api-token",
          principalKey: context.principalKey,
          idempotencyKey,
          body: canonicalInput,
          operationId,
        }));
        const created = await createApiToken({ ...input, principal: context.principal, credential }, new Date(), tx);
        return { status: 201, body: { ...serializeToken(created.token), token: created.secret } };
      }),
      persistBody: (body) => ({
        id: body.id,
        name: body.name,
        scopes: body.scopes,
        createdAt: body.createdAt,
        expiresAt: body.expiresAt,
        lastUsedAt: body.lastUsedAt,
        revokedAt: body.revokedAt,
      }),
      replayBody: (stored, { operationId }) => ({
        ...(stored as Omit<CreatedTokenData, "token">),
        token: deriveBearerToken(credentialDerivationContext({
          kind: "api-token",
          principalKey: context.principalKey,
          idempotencyKey,
          body: canonicalInput,
          operationId,
        })).raw,
      }),
    });
    return apiJson(objectEnvelope("CreatedToken", result.body, context.requestId), { status: result.status });
  } catch (error) {
    if (error instanceof TokenServiceError) {
      return apiError(context.requestId, error.code === "SCOPE_DENIED" ? 403 : 400, error.code, error.message);
    }
    return routeError(error, context.requestId);
  }
}

type CreatedTokenData = ReturnType<typeof serializeToken> & { token: string };

export async function GET(request: Request) {
  const context = await authorize(request, { scope: "tokens:manage" });
  if (isApiResponse(context)) return context;
  const url = new URL(request.url);
  const limit = pageLimit(url.searchParams.get("limit"));
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  if (!limit || (url.searchParams.has("cursor") && !cursor)) {
    return apiError(context.requestId, 400, "INVALID_CURSOR", "Cursor or limit is invalid");
  }
  const page = await listApiTokens({ cursor, limit });
  return apiJson(listEnvelope("TokenList", page.tokens.map(serializeToken), context.requestId,
    page.nextCursor ? encodeCursor(page.nextCursor) : null));
}

function serializeToken(token: {
  id: string; name: string; scopes: readonly string[]; createdAt: Date; expiresAt: Date; lastUsedAt: Date | null; revokedAt: Date | null;
}) {
  return {
    id: token.id,
    name: token.name,
    scopes: token.scopes,
    createdAt: token.createdAt.toISOString(),
    expiresAt: token.expiresAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    revokedAt: token.revokedAt?.toISOString() ?? null,
  };
}
