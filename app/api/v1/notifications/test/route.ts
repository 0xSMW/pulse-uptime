import { z } from "zod"

import { apiError, apiJson } from "@/lib/api/envelopes"
import { executeIdempotent } from "@/lib/api/idempotency"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import {
  OperationalInputError,
  operationalService,
} from "@/lib/api/operational-service"
import { routeError, storedSuccess } from "@/lib/api/route"

const requestSchema = z
  .object({ recipient: z.string().trim().email().optional() })
  .strict()

export async function POST(request: Request) {
  const context = await authorize(request, {
    scope: "notifications:test",
    rateLimit: { routeKey: "notification-test", limit: 10, windowSeconds: 300 },
  })
  if (isApiResponse(context)) {
    return context
  }
  try {
    const body = requestSchema.safeParse(await request.json())
    if (!body.success) {
      return apiError(
        context.requestId,
        400,
        "INVALID_REQUEST",
        "Recipient must be a valid email address"
      )
    }
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: "notification-test",
      body: body.data,
      work: async () =>
        storedSuccess(
          "NotificationTest",
          await operationalService.enqueueTestNotification({
            recipient: body.data.recipient,
            testId: request.headers.get("idempotency-key")!,
            installationName:
              context.principal.type === "cli_session"
                ? context.principal.installation?.displayName
                : null,
          }),
          context.requestId,
          202
        ),
    })
    return apiJson(result.body, { status: result.status })
  } catch (error) {
    if (error instanceof OperationalInputError) {
      return apiError(context.requestId, 400, error.code, error.message)
    }
    return routeError(error, context.requestId)
  }
}
