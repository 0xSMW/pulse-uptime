import { apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError } from "@/lib/api/route"
import { listTeam } from "@/lib/auth/invites"

export async function GET(request: Request) {
  const context = await authorize(request, { scope: "users:manage" })
  if (isApiResponse(context)) {
    return context
  }
  try {
    const team = await listTeam()
    return apiJson(
      objectEnvelope(
        "Team",
        {
          users: team.users.map((user) => ({
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            createdAt: user.createdAt.toISOString(),
            lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
          })),
          invites: team.invites.map((invite) => ({
            id: invite.id,
            role: invite.role,
            createdBy: invite.createdByPrincipal,
            createdAt: invite.createdAt.toISOString(),
            expiresAt: invite.expiresAt.toISOString(),
          })),
        },
        context.requestId
      )
    )
  } catch (error) {
    return routeError(error, context.requestId)
  }
}
