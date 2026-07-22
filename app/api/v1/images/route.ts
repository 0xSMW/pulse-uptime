import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes"
import {
  createImage,
  ImageServiceError,
  MAX_IMAGE_BYTES,
} from "@/lib/api/images"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { routeError } from "@/lib/api/route"
import { hasScope } from "@/lib/api/scopes"

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
    form = await request.formData()
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
  if (!(selfService || hasScope(context.principal, "config:write"))) {
    return apiError(
      context.requestId,
      403,
      "SCOPE_DENIED",
      "The credential lacks the required scope",
      { scope: "config:write" }
    )
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
    })
    return apiJson(objectEnvelope("Image", { id }, context.requestId), {
      status: 201,
    })
  } catch (error) {
    if (error instanceof ImageServiceError) {
      return apiError(context.requestId, 400, error.code, error.message)
    }
    return routeError(error, context.requestId)
  }
}
