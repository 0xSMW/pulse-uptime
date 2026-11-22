import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes"
import {
  createImage,
  ImageServiceError,
  MAX_IMAGE_BYTES,
} from "@/lib/api/images"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { enforceRateLimit } from "@/lib/api/rate-limit"
import { routeError } from "@/lib/api/route"
import { hasScope } from "@/lib/api/scopes"

export const AVATAR_UPLOAD_LIMIT = {
  routeKey: "images:avatar:upload",
  limit: 20,
  windowSeconds: 300,
} as const

const MAX_UPLOAD_REQUEST_BYTES = 1024 * 1024

/** Cap the entire multipart body before the form parser allocates its fields. */
async function parseBoundedFormData(
  request: Request
): Promise<FormData | "too-large"> {
  const declaredLength = request.headers.get("content-length")
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_UPLOAD_REQUEST_BYTES
  ) {
    return "too-large"
  }

  if (!request.body) {
    return request.formData()
  }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.byteLength
      if (size > MAX_UPLOAD_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined)
        return "too-large"
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return new Response(Buffer.concat(chunks, size), {
    headers: { "Content-Type": request.headers.get("content-type") ?? "" },
  }).formData()
}

/**
 * Multipart image upload for status page branding and account avatars.
 * Branding kinds require config:write. Avatars are self-service, so any
 * signed-in person may upload one, viewers included.
 */
export async function POST(request: Request) {
  const context = await authorize(request)
  if (isApiResponse(context)) {
    return context
  }
  let form: FormData
  try {
    const parsed = await parseBoundedFormData(request)
    if (parsed === "too-large") {
      return apiError(
        context.requestId,
        413,
        "IMAGE_TOO_LARGE",
        "Upload request must be at most 1 MiB"
      )
    }
    form = parsed
  } catch {
    return apiError(
      context.requestId,
      400,
      "INVALID_FORM",
      'Request must be multipart/form-data with "file" and "kind" fields'
    )
  }
  const file = form.get("file")
  const kind = form.get("kind")
  if (!(file instanceof File) || typeof kind !== "string") {
    return apiError(
      context.requestId,
      400,
      "INVALID_FORM",
      'Request must be multipart/form-data with "file" and "kind" fields'
    )
  }
  const selfService = kind === "avatar" && context.principal.type === "human"
  if (kind === "avatar" && context.principal.type !== "human") {
    return apiError(
      context.requestId,
      403,
      "SESSION_REQUIRED",
      "Avatar uploads require a dashboard session"
    )
  }
  if (!(selfService || hasScope(context.principal, "config:write"))) {
    return apiError(
      context.requestId,
      403,
      "SCOPE_DENIED",
      "The credential lacks the required scope",
      { scope: "config:write" }
    )
  }
  if (selfService) {
    const rate = await enforceRateLimit(
      context.principalKey,
      AVATAR_UPLOAD_LIMIT
    )
    if (!rate.allowed) {
      const response = apiError(
        context.requestId,
        429,
        "RATE_LIMITED",
        "Too many requests"
      )
      response.headers.set("Retry-After", String(rate.retryAfterSeconds))
      return response
    }
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return apiError(
      context.requestId,
      400,
      "IMAGE_TOO_LARGE",
      `Images must be at most ${Math.floor(MAX_IMAGE_BYTES / 1024)} KB`
    )
  }
  try {
    const { id } = await createImage({
      kind,
      mimeType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
      principal: context.principal,
      uploadedByUserId:
        kind === "avatar" && context.principal.type === "human"
          ? context.principal.id
          : null,
    })
    return apiJson(objectEnvelope("Image", { id }, context.requestId), {
      status: 201,
    })
  } catch (error) {
    if (error instanceof ImageServiceError) {
      return apiError(
        context.requestId,
        error.code === "SCOPE_DENIED" ? 403 : 400,
        error.code,
        error.message
      )
    }
    return routeError(error, context.requestId)
  }
}
