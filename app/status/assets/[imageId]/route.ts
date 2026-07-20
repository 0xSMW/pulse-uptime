import { findImage, imageResponse } from "@/lib/api/images";
import { isDatabaseUnavailableError } from "@/lib/db/errors";

/**
 * Public status page assets. Serves logo kinds only: favicons are inlined as
 * data: URIs by the status page itself, and avatars are dashboard-private.
 * Ids rotate on re-upload, so responses are immutable and CDN-cacheable
 * (s-maxage is what lets Vercel's CDN absorb repeat hits).
 */
const PUBLIC_IMAGE_KINDS = new Set(["logo-light", "logo-dark"]);

const PUBLIC_CACHE_CONTROL = "public, max-age=31536000, s-maxage=31536000, immutable";

export async function GET(_request: Request, { params }: { params: Promise<{ imageId: string }> }) {
  const { imageId } = await params;
  // Route handlers don't run at build time, so this never affects the
  // no-DATABASE_URL Preview build, but a runtime DB outage should return a
  // plain, retryable 503 instead of an uncaught 500.
  let image: Awaited<ReturnType<typeof findImage>>;
  try {
    image = await findImage(imageId);
  } catch (error) {
    if (!isDatabaseUnavailableError(error)) throw error;
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!image || !PUBLIC_IMAGE_KINDS.has(image.kind)) {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return imageResponse(image, PUBLIC_CACHE_CONTROL);
}
