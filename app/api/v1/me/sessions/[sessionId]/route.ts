import { AccountServiceError, revokeAccountSession } from "@/lib/api/account";
import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { routeError } from "@/lib/api/route";
import { getCurrentSession } from "@/lib/auth/session";
import { isUuid } from "@/lib/ids/uuid";

export async function DELETE(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const context = await authorize(request);
  if (isApiResponse(context)) return context;
  if (context.principal.type !== "human") {
    return apiError(context.requestId, 403, "SESSION_REQUIRED", "Account settings require a dashboard session");
  }
  const session = await getCurrentSession();
  if (!session) {
    return apiError(context.requestId, 401, "AUTHENTICATION_REQUIRED", "Valid authentication is required");
  }
  const { sessionId } = await params;
  if (!isUuid(sessionId)) {
    return apiError(context.requestId, 400, "INVALID_SESSION", "Session ID is invalid");
  }
  try {
    await revokeAccountSession({
      userId: context.principal.id,
      sessionId,
      currentSessionId: session.sessionId,
    });
    return apiJson(objectEnvelope("SessionRevocation", { id: sessionId, revoked: true }, context.requestId));
  } catch (error) {
    if (error instanceof AccountServiceError) {
      const status = error.code === "CURRENT_SESSION" ? 409 : error.code === "SESSION_NOT_FOUND" ? 404 : 400;
      return apiError(context.requestId, status, error.code, error.message);
    }
    return routeError(error, context.requestId);
  }
}
