import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { executeIdempotent } from "@/lib/api/idempotency"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError } from "@/lib/api/route"
import { revokeUserInvite, TeamServiceError } from "@/lib/auth/invites"
import { isUuid } from "@/lib/ids/uuid"

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ inviteId: string }> }
) {
  const context = await authorize(request, { scope: "users:manage" })
  if (isApiResponse(context)) {
    return context
  }
  const { inviteId } = await params
  if (!isUuid(inviteId)) {
    return apiError(
      context.requestId,
      400,
      "INVALID_INVITE",
      "Invite ID is invalid"
    )
  }
  try {
    const result = await executeIdempotent<{
      invite: { id: string } | null
    }>({
      request,
      principalKey: context.principalKey,
      routeKey: "invite-revoke",
      body: { inviteId },
      mode: "atomic",
      work: async (tx) => {
        try {
          const invite = await revokeUserInvite(inviteId, new Date(), tx)
          return { status: 200, body: { invite } }
        } catch (error) {
          if (
            error instanceof TeamServiceError &&
            error.code === "INVITE_INVALID"
          ) {
            return { status: 404, body: { invite: null } }
          }
          throw error
        }
      },
    })
    if (!result.body.invite) {
      return apiError(
        context.requestId,
        404,
        "INVITE_NOT_FOUND",
        "Invite is not pending"
      )
    }
    return apiJson(
      objectEnvelope("InviteRevocation", result.body.invite, context.requestId),
      { status: result.status }
    )
  } catch (error) {
    return routeError(error, context.requestId)
  }
}
