import { apiError } from "@/lib/api/envelopes";
import { findImage, imageResponse } from "@/lib/api/images";
import { authorize, isApiResponse } from "@/lib/api/middleware";

/**
 * Authenticated image bytes for dashboard rendering (avatar and branding
 * previews). Session-only: bearer tokens have no use for pixels, and avatars
 * must never be served from the public asset route.
 */
export async function GET(request: Request, { params }: { params: Promise<{ imageId: string }> }) {
  const context = await authorize(request);
  if (isApiResponse(context)) return context;
  if (context.principal.type !== "human") {
    return apiError(context.requestId, 403, "SESSION_REQUIRED", "Image previews require a dashboard session");
  }
  const { imageId } = await params;
  const image = await findImage(imageId);
  if (!image) {
    return apiError(context.requestId, 404, "IMAGE_NOT_FOUND", "The image was not found");
  }
  return imageResponse(image, "private, max-age=300");
}
