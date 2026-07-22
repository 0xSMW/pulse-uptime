import { eq } from "drizzle-orm"
import {
  apiError,
  apiJson,
  errorEnvelope,
  objectEnvelope,
} from "@/lib/api/envelopes"
import { executeIdempotent, type StoredResponse } from "@/lib/api/idempotency"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import type { Principal } from "@/lib/api/principal"
import { routeError } from "@/lib/api/route"
import {
  changeUserRole,
  removeUser,
  TeamServiceError,
} from "@/lib/auth/invites"
import { db } from "@/lib/db/client"
import { adminUsers } from "@/lib/db/schema"
import { isUuid } from "@/lib/ids/uuid"

function teamErrorStatus(code: TeamServiceError["code"]): number {
  if (code === "USER_NOT_FOUND") {
    return 404
  }
  if (code === "LAST_ADMIN" || code === "SELF_FORBIDDEN") {
    return 409
  }
  return 400
}

function teamError(error: unknown, requestId: string): Response | null {
  if (!(error instanceof TeamServiceError)) {
    return null
  }
  return apiError(
    requestId,
    teamErrorStatus(error.code),
    error.code,
    error.message
  )
}

// A TeamServiceError is a real outcome of current team state, not evidence the
// mutation never ran, so the completion commits alongside this stored error
// instead of leaving the record open for a stale-window retry.
function storedTeamError(
  error: TeamServiceError,
  requestId: string
): StoredResponse {
  return {
    status: teamErrorStatus(error.code),
    body: errorEnvelope(error.code, error.message, requestId),
  }
}

/**
 * The user identity behind the calling credential. CLI sessions act as the
 * person they were approved for, so they resolve through their linked email.
 * Standalone API tokens have no user identity and cannot pass self-checks.
 */
async function actorUserId(principal: Principal): Promise<string | null> {
  if (principal.type === "human") {
    return principal.id
  }
  if (principal.type === "cli_session") {
    const [user] = await db
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(eq(adminUsers.email, principal.email))
      .limit(1)
    return user?.id ?? null
  }
  return null
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  const context = await authorize(request, { scope: "users:manage" })
  if (isApiResponse(context)) {
    return context
  }
  const { userId } = await params
  if (!isUuid(userId)) {
    return apiError(
      context.requestId,
      400,
      "INVALID_USER",
      "User ID is invalid"
    )
  }
  try {
    const body = (await request.json()) as { role?: unknown } | null
    // The service owns its transaction and advisory lock, so the idempotency
    // record completes post-hoc instead of inside a helper transaction.
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: "user-role-change",
      body: { userId, role: body?.role ?? null },
      mode: "conservative",
      work: async () => {
        try {
          const changed = await changeUserRole({ userId, role: body?.role })
          return {
            status: 200,
            body: objectEnvelope(
              "TeamUser",
              {
                id: changed.id,
                email: changed.email,
                role: changed.role,
                revokedCliSessions: changed.revokedCliSessions,
                revokedApiTokens: changed.revokedApiTokens,
              },
              context.requestId
            ),
          }
        } catch (error) {
          if (error instanceof TeamServiceError) {
            return storedTeamError(error, context.requestId)
          }
          throw error
        }
      },
    })
    return apiJson(result.body, { status: result.status })
  } catch (error) {
    return (
      teamError(error, context.requestId) ??
      routeError(error, context.requestId)
    )
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  const context = await authorize(request, { scope: "users:manage" })
  if (isApiResponse(context)) {
    return context
  }
  const { userId } = await params
  if (!isUuid(userId)) {
    return apiError(
      context.requestId,
      400,
      "INVALID_USER",
      "User ID is invalid"
    )
  }
  const actor = await actorUserId(context.principal)
  if (!actor) {
    return apiError(
      context.requestId,
      403,
      "ACTOR_REQUIRED",
      "Removing users requires a credential linked to a person"
    )
  }
  try {
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: "user-remove",
      body: { userId },
      mode: "conservative",
      work: async () => {
        try {
          const removed = await removeUser({ userId, actorUserId: actor })
          return {
            status: 200,
            body: objectEnvelope("UserRemoval", removed, context.requestId),
          }
        } catch (error) {
          if (error instanceof TeamServiceError) {
            return storedTeamError(error, context.requestId)
          }
          throw error
        }
      },
    })
    return apiJson(result.body, { status: result.status })
  } catch (error) {
    return (
      teamError(error, context.requestId) ??
      routeError(error, context.requestId)
    )
  }
}
