import "server-only"

import type { DatabaseHandle } from "@/lib/db/client"

import { apiJson, errorEnvelope, objectEnvelope } from "./envelopes"
import {
  executeIdempotent,
  type IdempotencyWorkContext,
  type StoredResponse,
} from "./idempotency"
import { hasLiveScope } from "./live-authority"
import type { ApiContext } from "./middleware"
import { routeError } from "./route"
import type { ApiScope } from "./scopes"

export interface AtomicMutationOutcome<T> {
  status: number
  kind: string
  data: T
}

/**
 * Runs a mutation and its idempotency completion in one transaction.
 * Deterministic domain errors become stored responses when `storedError`
 * recognizes them. Other failures escape the transaction so both writes roll
 * back and a later retry can run the mutation again.
 */
export async function runAtomicMutation<T>(input: {
  request: Request
  context: ApiContext
  scope: ApiScope
  routeKey: string
  body: unknown
  work: (
    tx: DatabaseHandle,
    context: IdempotencyWorkContext
  ) => Promise<AtomicMutationOutcome<T>>
  storedError: (error: unknown, requestId: string) => StoredResponse | null
  mapError: (error: unknown, requestId: string) => Response | null
}): Promise<Response> {
  const {
    request,
    context,
    scope,
    routeKey,
    body,
    work,
    storedError,
    mapError,
  } = input
  try {
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey,
      body,
      mode: "atomic",
      work: async (tx, idempotencyContext) => {
        if (!(await hasLiveScope(tx, context.principal, scope))) {
          return {
            status: 403,
            body: errorEnvelope(
              "SCOPE_DENIED",
              "The credential no longer has the required scope",
              context.requestId,
              { scope }
            ),
          }
        }
        try {
          const outcome = await work(tx, idempotencyContext)
          return {
            status: outcome.status,
            body: objectEnvelope(outcome.kind, outcome.data, context.requestId),
          }
        } catch (error) {
          const stored = storedError(error, context.requestId)
          if (stored) {
            return stored
          }
          throw error
        }
      },
    })
    return apiJson(result.body, { status: result.status })
  } catch (error) {
    return (
      mapError(error, context.requestId) ?? routeError(error, context.requestId)
    )
  }
}
