import "server-only"

import { mutationOriginAllowed } from "@/lib/auth/origin"

import { apiError, requestIdFrom } from "./envelopes"
import { type Principal, resolvePrincipal } from "./principal"
import {
  AUTHENTICATED_MUTATION_LIMIT,
  AUTHENTICATED_READ_LIMIT,
  enforceRateLimit,
  type RateLimitPolicy,
} from "./rate-limit"
import { type ApiScope, hasScope } from "./scopes"

export interface ApiContext {
  principal: Principal
  principalKey: string
  requestId: string
}

export async function authorize(
  request: Request,
  options: { scope?: ApiScope; rateLimit?: RateLimitPolicy | false } = {}
): Promise<ApiContext | Response> {
  const requestId = requestIdFrom(request)
  const principal = await resolvePrincipal(request)
  if (!principal) {
    const response = apiError(
      requestId,
      401,
      "AUTHENTICATION_REQUIRED",
      "Valid authentication is required"
    )
    response.headers.set(
      "WWW-Authenticate",
      'Bearer realm="pulse", error="invalid_token"'
    )
    return response
  }
  if (
    principal.type === "human" &&
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    !mutationOriginAllowed(request)
  ) {
    return apiError(
      requestId,
      403,
      "INVALID_ORIGIN",
      "Request origin is not allowed"
    )
  }
  if (options.scope && !hasScope(principal, options.scope)) {
    return apiError(
      requestId,
      403,
      "SCOPE_DENIED",
      "The credential lacks the required scope",
      {
        scope: options.scope,
      }
    )
  }
  const principalKey = `${principal.type}:${principal.id}`
  const defaults =
    request.method === "GET"
      ? AUTHENTICATED_READ_LIMIT
      : AUTHENTICATED_MUTATION_LIMIT
  const policy =
    options.rateLimit === false
      ? null
      : (options.rateLimit ?? {
          ...defaults,
          routeKey:
            request.method === "GET"
              ? "authenticated-read"
              : "authenticated-mutation",
        })
  if (policy) {
    const rate = await enforceRateLimit(principalKey, policy)
    if (!rate.allowed) {
      const response = apiError(
        requestId,
        429,
        "RATE_LIMITED",
        "Too many requests"
      )
      response.headers.set("Retry-After", String(rate.retryAfterSeconds))
      return response
    }
  }
  return { principal, principalKey, requestId }
}

export function isApiResponse(value: ApiContext | Response): value is Response {
  return value instanceof Response
}
