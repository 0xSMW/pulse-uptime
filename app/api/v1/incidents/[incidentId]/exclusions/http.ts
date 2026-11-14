import { revalidatePath } from "next/cache"
import { z } from "zod"
import {
  apiError,
  apiJson,
  errorEnvelope,
  objectEnvelope,
} from "@/lib/api/envelopes"
import { executeIdempotent } from "@/lib/api/idempotency"
import type { ApiContext } from "@/lib/api/middleware"
import { routeError } from "@/lib/api/route"
import type { DatabaseHandle } from "@/lib/db/client"
import { IncidentExclusionError } from "@/lib/incidents/exclusions"

export const rangeSchema = z
  .object({
    startAt: z.iso.datetime({ offset: true }).optional(),
    endAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
export const applySchema = z
  .object({
    startAt: z.iso.datetime({ offset: true }),
    endAt: z.iso.datetime({ offset: true }),
    reason: z.string().trim().min(1).max(1000),
    previewVersion: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export function exclusionError(error: unknown, requestId: string) {
  return error instanceof IncidentExclusionError
    ? apiError(requestId, error.status, error.code, error.message)
    : routeError(error, requestId)
}
export async function runExclusionMutation(
  request: Request,
  context: ApiContext,
  body: unknown,
  work: (
    tx: DatabaseHandle,
    operationId: string
  ) => Promise<{ monitorId: string }>,
  status: number
) {
  try {
    let monitorId: string | undefined
    const result = await executeIdempotent<unknown>({
      request,
      principalKey: context.principalKey,
      routeKey: new URL(request.url).pathname,
      body,
      mode: "atomic",
      work: async (tx, operation) => {
        try {
          const data = await work(tx, operation.operationId)
          monitorId = data.monitorId
          return {
            status,
            body: objectEnvelope("IncidentExclusion", data, context.requestId),
          }
        } catch (error) {
          if (!(error instanceof IncidentExclusionError)) {
            throw error
          }
          return {
            status: error.status,
            body: errorEnvelope(error.code, error.message, context.requestId),
          }
        }
      },
    })
    if (!result.replayed && monitorId) {
      for (const path of [
        "/",
        "/incidents",
        `/incidents/${encodeURIComponent(new URL(request.url).pathname.split("/")[4]!)}`,
        "/monitors",
        `/monitors/${encodeURIComponent(monitorId)}`,
        "/status",
      ]) {
        revalidatePath(path)
      }
      revalidatePath("/status/[group]", "page")
    }
    return apiJson(result.body, { status: result.status })
  } catch (error) {
    return exclusionError(error, context.requestId)
  }
}
