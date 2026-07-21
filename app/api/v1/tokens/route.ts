import { apiError, apiJson, listEnvelope, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent, requireIdempotencyKey } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { decodeCursor, encodeCursor, pageLimit } from "@/lib/api/pagination";
import { routeError } from "@/lib/api/route";
import { createApiToken, listApiTokens, TokenServiceError, validateTokenInput } from "@/lib/api/token-service";
import { credentialDerivationContext, deriveBearerToken } from "@/lib/api/tokens";

const TOKEN_CREATE_LIMIT = { routeKey: "token-create", limit: 10, windowSeconds: 60 * 60 };

export type CreatedTokenData = ReturnType<typeof serializeToken> & {
  token: string;
  /** True when the requested or default expiry was clamped to the creator's remaining lifetime. */
  expiryClamped: boolean;
};

/** Stored under the idempotency key: every field except the one-time secret. */
export type PersistedCreatedTokenData = Omit<CreatedTokenData, "token">;

/** Drop the secret for persistence. Future non-secret fields stay automatically. */
export function persistCreatedToken(body: CreatedTokenData): PersistedCreatedTokenData {
  const { token: _token, ...persisted } = body;
  void _token;
  return persisted;
}

/** Rebuild the deterministic secret and restore the stored response body as-is. */
export function replayCreatedToken(
  stored: PersistedCreatedTokenData,
  token: string,
): CreatedTokenData {
  return { ...stored, token };
}

export async function POST(request: Request) {
  const context = await authorize(request, { scope: "tokens:manage", rateLimit: TOKEN_CREATE_LIMIT });
  if (isApiResponse(context)) return context;
  try {
    const { clamped, ...input } = validateTokenInput(await request.json(), context.principal);
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
        return {
          status: 201,
          body: {
            ...serializeToken(created.token),
            token: created.secret,
            expiryClamped: clamped,
          },
        };
      }),
      persistBody: persistCreatedToken,
      replayBody: (stored, { operationId }) => replayCreatedToken(
        stored as PersistedCreatedTokenData,
        deriveBearerToken(credentialDerivationContext({
          kind: "api-token",
          principalKey: context.principalKey,
          idempotencyKey,
          body: canonicalInput,
          operationId,
        })).raw,
      ),
    });
    return apiJson(objectEnvelope("CreatedToken", result.body, context.requestId), { status: result.status });
  } catch (error) {
    if (error instanceof TokenServiceError) {
      return apiError(context.requestId, error.code === "SCOPE_DENIED" ? 403 : 400, error.code, error.message);
    }
    return routeError(error, context.requestId);
  }
}

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
