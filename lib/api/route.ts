import { apiError, apiJson, objectEnvelope } from "./envelopes"
import { IdempotencyError, type StoredResponse } from "./idempotency"

export function success<T>(
  kind: string,
  data: T,
  requestId: string,
  status = 200
) {
  return apiJson(objectEnvelope(kind, data, requestId), { status })
}

export function storedSuccess<T>(
  kind: string,
  data: T,
  requestId: string,
  status = 200
): StoredResponse {
  return { status, body: objectEnvelope(kind, data, requestId) }
}

export function routeError(error: unknown, requestId: string): Response {
  if (error instanceof IdempotencyError) {
    const status = error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409
    return apiError(requestId, status, error.code, error.message)
  }
  if (error instanceof SyntaxError) {
    return apiError(
      requestId,
      400,
      "INVALID_JSON",
      "Request body must be valid JSON"
    )
  }
  return apiError(
    requestId,
    500,
    "INTERNAL_ERROR",
    "The request could not be completed"
  )
}
