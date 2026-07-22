import {
  type MachineCredentialRevocationResult,
  revokeCliInstallationById,
} from "@/lib/api/device-authorization"
import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes"
import { executeIdempotent } from "@/lib/api/idempotency"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError } from "@/lib/api/route"
import { isUuid } from "@/lib/ids/uuid"

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ installationId: string }> }
) {
  const context = await authorize(request, { scope: "tokens:manage" })
  if (isApiResponse(context)) {
    return context
  }
  if (context.principal.type !== "human") {
    return apiError(
      context.requestId,
      403,
      "SESSION_REQUIRED",
      "CLI installation management requires a dashboard session"
    )
  }
  const { installationId } = await params
  if (!isUuid(installationId)) {
    return apiError(
      context.requestId,
      400,
      "INVALID_INSTALLATION",
      "Installation ID is invalid"
    )
  }
  try {
    const result = await executeIdempotent<{
      revocation: MachineCredentialRevocationResult | null
    }>({
      request,
      principalKey: context.principalKey,
      routeKey: "cli-installation-admin-revoke",
      body: { installationId },
      mode: "atomic",
      work: async (tx) => ({
        status: 200,
        body: {
          revocation: await revokeCliInstallationById(
            installationId,
            new Date(),
            tx
          ),
        },
      }),
    })
    if (!result.body.revocation) {
      return apiError(
        context.requestId,
        404,
        "INSTALLATION_NOT_FOUND",
        "CLI installation was not found"
      )
    }
    return apiJson(
      objectEnvelope(
        "MachineCredentialRevocation",
        result.body.revocation,
        context.requestId
      )
    )
  } catch (error) {
    return routeError(error, context.requestId)
  }
}
