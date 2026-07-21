import { revalidatePath } from "next/cache"

import {
  apiError,
  apiJson,
  errorEnvelope,
  objectEnvelope,
} from "@/lib/api/envelopes"
import { executeIdempotent, type StoredResponse } from "@/lib/api/idempotency"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError } from "@/lib/api/route"
import {
  getStatusPageConfig,
  putStatusPageConfig,
  type StatusPageConfigData,
  StatusPageConfigError,
  statusPageConfigEtag,
} from "@/lib/api/status-page-config"

function configResponse(
  data: StatusPageConfigData,
  etag: string,
  requestId: string
) {
  const response = apiJson(objectEnvelope("StatusPageConfig", data, requestId))
  response.headers.set("ETag", etag)
  return response
}

function statusPageConfigErrorStatus(error: StatusPageConfigError): number {
  return error.code === "PRECONDITION_FAILED"
    ? 412
    : error.code === "CONFIG_UNAVAILABLE"
      ? 503
      : 400
}

function configError(error: unknown, requestId: string) {
  if (error instanceof StatusPageConfigError) {
    return apiError(
      requestId,
      statusPageConfigErrorStatus(error),
      error.code,
      error.message,
      error.details
    )
  }
  return routeError(error, requestId)
}

/**
 * Maps a StatusPageConfigError to a StoredResponse, mirroring
 * storedStatusReportError in lib/api/status-report-http.ts: PRECONDITION_FAILED
 * (and the other deterministic config errors) is a deterministic outcome of
 * CURRENT state, not proof the operation never ran, so it must be recorded
 * as this operation's own response inside work() rather than thrown past
 * executeIdempotent, since a thrown error would leave the idempotency record
 * running forever instead of completed.
 */
function storedConfigError(
  error: StatusPageConfigError,
  requestId: string
): StoredResponse<unknown> {
  return {
    status: statusPageConfigErrorStatus(error),
    body: errorEnvelope(error.code, error.message, requestId, error.details),
  }
}

/** Recomputes the ETag from the persisted document's version, stable across replay. */
function etagFor(data: StatusPageConfigData): string {
  return statusPageConfigEtag(data.version)
}

export async function GET(request: Request) {
  const context = await authorize(request, { scope: "config:read" })
  if (isApiResponse(context)) {
    return context
  }
  try {
    const { data, etag } = await getStatusPageConfig()
    return configResponse(data, etag, context.requestId)
  } catch (error) {
    return configError(error, context.requestId)
  }
}

export async function PUT(request: Request) {
  const context = await authorize(request, { scope: "config:write" })
  if (isApiResponse(context)) {
    return context
  }
  const ifMatch = request.headers.get("if-match")?.trim()
  if (!ifMatch) {
    return apiError(
      context.requestId,
      428,
      "PRECONDITION_REQUIRED",
      "The If-Match header is required; read the configuration and resend with its ETag"
    )
  }
  try {
    const body = await request.json()
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey: "/api/v1/status-page-config",
      // The idempotency fingerprint must include the precondition, not just
      // the document: executeIdempotent hashes only this `body` value (plus
      // method/path/query), so a key reused with the SAME document but a
      // FRESH If-Match (e.g. re-read after a 412, then resubmitted under the
      // same key) would otherwise hash identically to the first attempt and
      // replay its stored response instead of being evaluated against the
      // new precondition. Folding ifMatch in here makes that combination
      // hash differently, so it surfaces as IDEMPOTENCY_KEY_REUSED, the
      // correct explicit signal to mint a new key, rather than a silent
      // stale replay. `work` below closes over the real `body` and `ifMatch`
      // directly, so this composite is used only for hashing.
      body: { ifMatch, document: body },
      mode: "atomic",
      work: async (tx) => {
        try {
          const { data } = await putStatusPageConfig(body, ifMatch, {
            handle: tx,
          })
          return { status: 200, body: data }
        } catch (error) {
          if (error instanceof StatusPageConfigError) {
            return storedConfigError(error, context.requestId)
          }
          throw error
        }
      },
    })
    if (result.status !== 200) {
      return apiJson(result.body, { status: result.status })
    }
    // Revalidate only after the guarded write and the idempotency completion
    // commit, so a public status visit in the window never reads the old
    // config and caches the stale branding for the ISR window while this PUT
    // is still uncommitted. A replayed key already revalidated on its
    // original run, so it skips this. Branding (logo, favicon, custom CSS,
    // announcement banner, nav links) is rendered by every public status
    // route, including report permalinks, so a layout-level revalidation is
    // the cleaner match for Next 15 semantics here than enumerating each
    // surface the way report mutations do in collectStatusReportPaths.
    if (!result.replayed) {
      revalidatePath("/status", "layout")
    }
    // The ETag is derived from the persisted version, not stored separately,
    // so a replayed idempotency key still returns a correct header without
    // re-running the write (and re-triggering the If-Match check) below.
    const data = result.body as StatusPageConfigData
    return configResponse(data, etagFor(data), context.requestId)
  } catch (error) {
    return configError(error, context.requestId)
  }
}
