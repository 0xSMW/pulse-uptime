import { revalidatePath } from "next/cache";

import { apiError, apiJson, errorEnvelope, objectEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent, type StoredResponse } from "@/lib/api/idempotency";
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

function statusPageConfigErrorStatus(error: StatusPageConfigError): number {
  return error.code === "PRECONDITION_FAILED" ? 412 : error.code === "CONFIG_UNAVAILABLE" ? 503 : 400;
}

function configError(error: unknown, requestId: string) {
  if (error instanceof StatusPageConfigError) {
    return apiError(requestId, statusPageConfigErrorStatus(error), error.code, error.message, error.details);
  }
  return routeError(error, requestId);
}

/**
 * Maps a StatusPageConfigError to a StoredResponse, mirroring
 * storedStatusReportError in lib/api/status-report-http.ts: PRECONDITION_FAILED
 * (and the other deterministic config errors) is a deterministic outcome of
 * CURRENT state, not proof the operation never ran, so it must be recorded
 * as this operation's own response inside work() rather than thrown past
 * executeIdempotent, since a thrown error would leave the idempotency record
 * stuck "running" until a stale reclaim's recover callback runs against a
 * body that no longer parses or a document that no longer matches.
 */
function storedConfigError(error: StatusPageConfigError, requestId: string): StoredResponse<unknown> {
  return { status: statusPageConfigErrorStatus(error), body: errorEnvelope(error.code, error.message, requestId, error.details) };
}

/** Recomputes the ETag from the persisted document's version; stable across replay. */
function etagFor(data: StatusPageConfigData): string {
  return statusPageConfigEtag(data.version);
}

/**
 * Parses the numeric version out of an If-Match value shaped exactly like
 * statusPageConfigEtag's output (a quoted, non-negative, no-leading-zero
 * integer). Anything else (a weak validator, a non-numeric value, or a
 * malformed header) is not "clean" and yields null.
 */
function ifMatchVersion(ifMatch: string): number | null {
  const match = /^"(0|[1-9][0-9]*)"$/.exec(ifMatch);
  return match ? Number(match[1]) : null;
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
      // stale replay. `work`/`recover` below close over the real `body` and
      // `ifMatch` directly, so this composite is used only for hashing.
      body: { ifMatch, document: body },
      // Recovery must prove THIS retry's own If-Match was satisfiable at the
      // moment the current state was written, not just that the current
      // document matches the submitted body. The guarded conditional UPDATE
      // advances `version` by exactly 1 per successful write and requires
      // `version = ifMatch` at write time, so a write guarded by If-Match=N
      // can only have produced version N+1: requiring
      // `current.version === ifMatchVersion + 1`, together with the CURRENT
      // document deep-equaling the submitted body (ignoring updatedAt and
      // version), proves that invariant. Anything else (stale If-Match,
      // version mismatch, malformed input, unreadable config, or an
      // unparseable body) returns null, denying recovery.
      //
      // Residual: two writers on the same base version submitting
      // byte-identical documents can both recover 200 against the same
      // version+body pair, which is harmless since that's exactly the state
      // both submitted.
      recover: async () => {
        const parsed = parseStatusPageConfigDocument(body);
        if (!parsed.success) return null;
        const current = await getStatusPageConfig().catch(() => null);
        if (!current) return null;
        const expectedVersion = ifMatchVersion(ifMatch);
        if (expectedVersion === null || current.data.version !== expectedVersion + 1) return null;
        const { updatedAt: _currentUpdatedAt, version: _currentVersion, ...currentDocument } = current.data;
        void _currentUpdatedAt;
        void _currentVersion;
        if (canonicalSerialize(currentDocument) !== canonicalSerialize(parsed.data)) return null;
        return { status: 200, body: current.data };
      },
      rerunAfterRecoveryMiss: false,
      work: async () => {
        try {
          const { data } = await putStatusPageConfig(body, ifMatch);
          // Branding (logo, favicon, custom CSS, announcement banner, nav
          // links) is rendered by every public status route, including
          // report permalinks, so a layout-level revalidation is the cleaner
          // match for Next 15 semantics here than enumerating each surface
          // the way report mutations do in revalidateStatusReportPaths.
          revalidatePath("/status", "layout");
          return { status: 200, body: data };
        } catch (error) {
          if (error instanceof StatusPageConfigError) return storedConfigError(error, context.requestId);
          throw error;
        }
      },
    });
    if (result.status !== 200) {
      return apiJson(result.body, { status: result.status });
    }
    // The ETag is derived from the persisted version, not stored separately,
    // so a replayed idempotency key still returns a correct header without
    // re-running the write (and re-triggering the If-Match check) below.
    const data = result.body as StatusPageConfigData;
    return configResponse(data, etagFor(data), context.requestId);
  } catch (error) {
    return configError(error, context.requestId);
  }
}
