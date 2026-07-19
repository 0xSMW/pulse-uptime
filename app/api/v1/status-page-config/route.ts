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
 * (and the other deterministic config errors) is recorded as this
 * operation's own response inside work() rather than thrown past
 * executeIdempotent (finding: a thrown 412 left the idempotency record stuck
 * "running" until a stale reclaim's recover callback ran on a body that no
 * longer parsed or a document that didn't match, and — before the fix below
 * — could even manufacture a false 200 for a genuinely stale If-Match).
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
 * integer). Anything else — a weak validator, a non-numeric value, or a
 * malformed header — is not "clean" and yields null.
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
      body,
      // A retry after a stale-record reclaim may be replaying a save that
      // already committed before a crash (finding: the write's guarded
      // UPDATE advances the monotonic `version` counter — and therefore the
      // ETag — on every successful write, so requiring THIS retry's If-Match
      // to still equal the CURRENT etag, as a prior pass did, means a normal
      // committed-then-crashed retry — whose If-Match is the PRE-write
      // value, e.g. "5" against a current "6" — always misses recovery,
      // reruns, and 412s against its own successful write). If the CURRENT
      // document already deep-equals what the caller submitted (ignoring the
      // read-only updatedAt/version), that alone used to be treated as this
      // operation's own recovered success — but that ignored whether THIS
      // retry's If-Match could ever have been the precondition that produced
      // the current state (finding: a document that merely happens to match
      // — e.g. two different writers converging on the same edit from
      // different base versions — would recover 200 without the retry's own
      // write ever having been possible). The guarded conditional UPDATE
      // advances `version` by exactly 1 per successful write and requires
      // `version = ifMatch` at write time, so a write guarded by If-Match=N
      // can only ever have produced version N+1: requiring
      // `current.version === ifMatchVersion + 1` here (in addition to the
      // document-equality check) proves this retry's precondition was
      // satisfiable at the moment that write landed. A genuinely stale
      // If-Match with a genuinely DIFFERENT body still 412s below (recorded
      // inside work(), not thrown — verified by the "genuine stale-If-Match
      // different-body first attempt" test); a version mismatch (another
      // writer advanced it further, or a genuinely stale base) returns null
      // here, which denies recovery (executeIdempotent's
      // rerunAfterRecoveryMiss: false surfaces "cannot recover safely, retry
      // with a new idempotency key" rather than silently rerunning work()
      // against a possibly-already-superseded body). Residual this still
      // can't distinguish: two writers reading the SAME base version and
      // submitting byte-identical documents — one commits (version base+1),
      // the other's crashed retry recovers 200 against that same version+body
      // pair — is benign, since the achieved state is exactly what both
      // submitted. Fully eliminating that residual would require recording
      // idempotency completion inside the config write's own transaction (a
      // follow-up, not done here). A malformed/non-numeric If-Match, an
      // unreadable config, or a body that no longer parses all return null.
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
    // The ETag is derived from updatedAt rather than persisted separately, so
    // a replayed idempotency key still returns a correct header without
    // re-running the write (and re-triggering the If-Match check) below.
    const data = result.body as StatusPageConfigData;
    return configResponse(data, etagFor(data), context.requestId);
  } catch (error) {
    return configError(error, context.requestId);
  }
}
