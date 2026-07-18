import { revalidatePath } from "next/cache";

import { apiError, apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent } from "@/lib/api/idempotency";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { routeError } from "@/lib/api/route";
import {
  getStatusPageConfig,
  putStatusPageConfig,
  statusPageConfigEtag,
  StatusPageConfigError,
  type StatusPageConfigData,
} from "@/lib/api/status-page-config";
import { canonicalSerialize } from "@/lib/config/canonical";
import { parseStatusPageConfigDocument } from "@/lib/status-page/schema";

function configResponse(data: StatusPageConfigData, etag: string, requestId: string) {
  const response = apiJson(objectEnvelope("StatusPageConfig", data, requestId));
  response.headers.set("ETag", etag);
  return response;
}

function configError(error: unknown, requestId: string) {
  if (error instanceof StatusPageConfigError) {
    const status = error.code === "PRECONDITION_FAILED" ? 412 : error.code === "CONFIG_UNAVAILABLE" ? 503 : 400;
    return apiError(requestId, status, error.code, error.message, error.details);
  }
  return routeError(error, requestId);
}

/** Recomputes the ETag from the persisted document; stable across replay. */
function etagFor(data: StatusPageConfigData): string {
  return statusPageConfigEtag(data.updatedAt === null ? null : new Date(data.updatedAt));
}

export async function GET(request: Request) {
  const context = await authorize(request, { scope: "config:read" });
  if (isApiResponse(context)) return context;
  try {
    const { data, etag } = await getStatusPageConfig();
    return configResponse(data, etag, context.requestId);
  } catch (error) {
    return configError(error, context.requestId);
  }
}

export async function PUT(request: Request) {
  const context = await authorize(request, { scope: "config:write" });
  if (isApiResponse(context)) return context;
  const ifMatch = request.headers.get("if-match")?.trim();
  if (!ifMatch) {
    return apiError(
      context.requestId,
      428,
      "PRECONDITION_REQUIRED",
      "The If-Match header is required; read the configuration and resend with its ETag",
    );
  }
  try {
    const body = await request.json();
    const result = await executeIdempotent<StatusPageConfigData>({
      request,
      principalKey: context.principalKey,
      routeKey: "/api/v1/status-page-config",
      body,
      // A retry after a stale-record reclaim may be replaying a save that
      // already committed before a crash (finding: rerunning would re-check
      // If-Match against the NEW updatedAt the prior attempt already wrote,
      // 412ing against its own successful write). If the CURRENT document
      // already deep-equals what the caller submitted (ignoring the
      // read-only updatedAt), treat that as this operation's own recovered
      // success; a genuinely different current document — or a body that no
      // longer parses — returns null so work() reruns (and a real conflict
      // still 412s there).
      recover: async () => {
        const parsed = parseStatusPageConfigDocument(body);
        if (!parsed.success) return null;
        const current = await getStatusPageConfig().catch(() => null);
        if (!current) return null;
        const { updatedAt: _currentUpdatedAt, ...currentDocument } = current.data;
        void _currentUpdatedAt;
        if (canonicalSerialize(currentDocument) !== canonicalSerialize(parsed.data)) return null;
        return { status: 200, body: current.data };
      },
      work: async () => {
        const { data } = await putStatusPageConfig(body, ifMatch);
        // Branding (logo, favicon, custom CSS, announcement banner, nav
        // links) is rendered by every public status route, including report
        // permalinks, so a layout-level revalidation is the cleaner match for
        // Next 15 semantics here than enumerating each surface the way
        // report mutations do in revalidateStatusReportPaths.
        revalidatePath("/status", "layout");
        return { status: 200, body: data };
      },
    });
    // The ETag is derived from updatedAt rather than persisted separately, so
    // a replayed idempotency key still returns a correct header without
    // re-running the write (and re-triggering the If-Match check) below.
    return configResponse(result.body, etagFor(result.body), context.requestId);
  } catch (error) {
    return configError(error, context.requestId);
  }
}
