import { getImage, imageResponse } from "@/lib/api/images";

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
  const image = await getImage(imageId);
  if (!image || !PUBLIC_IMAGE_KINDS.has(image.kind)) {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return imageResponse(image, PUBLIC_CACHE_CONTROL);
}
