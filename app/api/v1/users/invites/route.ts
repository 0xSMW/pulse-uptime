import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { executeIdempotent, requireIdempotencyKey } from "@/lib/api/idempotency"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError } from "@/lib/api/route"
import {
  credentialDerivationContext,
  deriveBearerToken,
  INVITE_TOKEN_PREFIX,
} from "@/lib/api/tokens"
import {
  createUserInvite,
  TeamServiceError,
  validateInviteRole,
} from "@/lib/auth/invites"

const INVITE_CREATE_LIMIT = {
  routeKey: "invite-create",
  limit: 10,
  windowSeconds: 60 * 60,
}

interface CreatedInviteData {
  id: string
  role: string
  token: string
  joinPath: string
  createdAt: string
  expiresAt: string
}

/** Stored under the idempotency key: every field except the one-time secret. */
type PersistedCreatedInviteData = Omit<CreatedInviteData, "token" | "joinPath">

function persistCreatedInvite(
  body: CreatedInviteData
): PersistedCreatedInviteData {
  const { token: _token, joinPath: _joinPath, ...persisted } = body
  void _token
  void _joinPath
  return persisted
}

function replayCreatedInvite(
  stored: PersistedCreatedInviteData,
  token: string
): CreatedInviteData {
  return { ...stored, token, joinPath: `/join/${token}` }
}

export async function POST(request: Request) {
  const context = await authorize(request, {
    scope: "users:manage",
    rateLimit: INVITE_CREATE_LIMIT,
  })
  if (isApiResponse(context)) {
    return context
  }
  try {
    const body = (await request.json()) as { role?: unknown } | null
    const role = validateInviteRole(body?.role)
    const idempotencyKey = requireIdempotencyKey(request)
    const canonicalBody = { role }
    const result = await executeIdempotent<CreatedInviteData>({
      request,
      principalKey: context.principalKey,
      routeKey: "invite-create",
      body: canonicalBody,
      mode: "atomic",
      work: async (tx, { operationId }) => {
        const credential = deriveBearerToken(
          credentialDerivationContext({
            kind: "user-invite",
            principalKey: context.principalKey,
            idempotencyKey,
            body: canonicalBody,
            operationId,
          }),
          INVITE_TOKEN_PREFIX
        )
        const invite = await createUserInvite(
          { role, createdByPrincipal: context.principalKey, credential },
          new Date(),
          tx
        )
        return {
          status: 201,
          body: {
            id: invite.id,
            role: invite.role,
            token: invite.token,
            joinPath: `/join/${invite.token}`,
            createdAt: invite.createdAt.toISOString(),
            expiresAt: invite.expiresAt.toISOString(),
          },
        }
      },
      persistBody: persistCreatedInvite,
      replayBody: (stored, { operationId }) =>
        replayCreatedInvite(
          stored as PersistedCreatedInviteData,
          deriveBearerToken(
            credentialDerivationContext({
              kind: "user-invite",
              principalKey: context.principalKey,
              idempotencyKey,
              body: canonicalBody,
              operationId,
            }),
            INVITE_TOKEN_PREFIX
          ).raw
        ),
    })
    return apiJson(
      objectEnvelope("CreatedInvite", result.body, context.requestId),
      { status: result.status }
    )
  } catch (error) {
    if (error instanceof TeamServiceError) {
      return apiError(context.requestId, 400, error.code, error.message)
    }
    return routeError(error, context.requestId)
  }
}
