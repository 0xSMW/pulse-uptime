import "server-only";

import { revalidatePath } from "next/cache";

import { statusGroupSlug } from "@/lib/reporting/queries/timeline";

import { apiError, apiJson, errorEnvelope, objectEnvelope } from "./envelopes";
import { executeIdempotent, type IdempotencyContext, type StoredResponse } from "./idempotency";
import { routeError } from "./route";
import { databaseStatusReportsStore, parseStatusReportPatch, StatusReportError } from "./status-reports";

function statusReportErrorStatus(error: StatusReportError): number {
  return error.code === "VALIDATION_ERROR" || error.code === "INVALID_CURSOR"
    ? 400
    : error.code === "LAST_UPDATE" || error.code === "ALREADY_PUBLISHED"
      ? 409
      : 404;
}

/** Shared HTTP mapping for the status-reports route family. */
export function statusReportRouteError(error: unknown, requestId: string): Response {
  if (error instanceof StatusReportError) {
    return apiError(requestId, statusReportErrorStatus(error), error.code, error.message, error.details);
  }
  return routeError(error, requestId);
}

/**
 * Maps a StatusReportError to a StoredResponse. Domain errors that are
 * deterministic outcomes of CURRENT state (publish's ALREADY_PUBLISHED, the
 * REPORT_NOT_FOUND/UPDATE_NOT_FOUND/LAST_UPDATE the report- and
 * update-mutation routes can throw) are never proof an operation didn't run,
 * so they must be recorded as the idempotent operation's own response. See
 * runStatusReportMutation's doc comment for why.
 */
export function storedStatusReportError(error: StatusReportError, requestId: string): StoredResponse {
  return { status: statusReportErrorStatus(error), body: errorEnvelope(error.code, error.message, requestId, error.details) };
}

type MutationOutcome<T> = { status: number; kind: string; data: T };

/**
 * Runs one idempotent status-report mutation end to end: acquires or replays
 * the idempotency record, wraps the domain result in the standard object
 * envelope, and maps everything onto an HTTP Response. Every mutation route
 * in the status-reports/incidents-promote family is authorize() → parse
 * params/body → one call here with route-specific `recover`/`work` closures.
 *
 * `work` returns the eventual `{ status, kind, data }` or throws
 * StatusReportError. `recover` returns the same shape for an already-applied
 * operation, or null to fall through to `work`. Two invariants this helper
 * owns on every call, so route files don't have to restate them:
 *
 * - A StatusReportError thrown by `work` is caught HERE and recorded as the
 *   operation's own completed response (via storedStatusReportError), never
 *   rethrown past executeIdempotent. A deterministic domain error (bad
 *   input, not-found, a conflict like ALREADY_PUBLISHED) is not evidence the
 *   operation never ran: letting it throw would leave the idempotency
 *   record stuck "running" until a stale reclaim, whose `recover` can't tell
 *   "never ran" from "failed this way" and would either force every retry
 *   into a REQUEST_IN_PROGRESS 409 or misread the failure's own state as a
 *   false recovered success.
 * - `rerunAfterRecoveryMiss` is always false. A recovery miss means either
 *   the operation never committed (safe to rerun) or a different, newer
 *   write changed the state since (rerunning would clobber it), which are
 *   indistinguishable from here, so a miss always surfaces "cannot recover
 *   safely, retry with a new idempotency key" instead of guessing.
 */
export async function runStatusReportMutation<T>(input: {
  request: Request;
  context: { principalKey: string; requestId: string };
  routeKey: string;
  body: unknown;
  recover?: (context: IdempotencyContext) => Promise<MutationOutcome<T> | null>;
  work: (context: IdempotencyContext) => Promise<MutationOutcome<T>>;
}): Promise<Response> {
  const { request, context, routeKey, body, recover, work } = input;
  try {
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey,
      body,
      recover: recover
        ? async (idempotencyContext) => {
            const outcome = await recover(idempotencyContext);
            return outcome
              ? { status: outcome.status, body: objectEnvelope(outcome.kind, outcome.data, context.requestId) }
              : null;
          }
        : undefined,
      rerunAfterRecoveryMiss: false,
      work: async (idempotencyContext) => {
        try {
          const outcome = await work(idempotencyContext);
          return { status: outcome.status, body: objectEnvelope(outcome.kind, outcome.data, context.requestId) };
        } catch (error) {
          if (error instanceof StatusReportError) return storedStatusReportError(error, context.requestId);
          throw error;
        }
      },
    });
    return apiJson(result.body, { status: result.status });
  } catch (error) {
    return statusReportRouteError(error, context.requestId);
  }
}

/**
 * Idempotency recovery check for PATCH /status-reports/{id}. True when the
 * CURRENT report already reflects everything the caller asked to change:
 * title/startsAt/endsAt equal wherever the caller sent them (compared as
 * instants, tolerant of formatting), and affected (if sent) equal as a set
 * of monitorId:impact pairs (order-independent, full-replacement semantics).
 * Fields the caller didn't send are never compared, since the patch never
 * touched them.
 */
export function statusReportPatchAlreadyApplied(
  current: {
    title: string;
    startsAt: string;
    endsAt: string | null;
    affected: ReadonlyArray<{ monitorId: string; impact: string }>;
  },
  body: unknown,
): boolean {
  // Parsed through the SAME patchSchema updateStatusReport uses: an INVALID
  // patch (`{}`, or a body with only unsupported keys) must return false
  // rather than falling through to `true` for "no recognized field
  // mismatches", which would recover a stale retry's genuine VALIDATION_ERROR
  // as a false 200. Comparing the PARSED patch (not the raw body) also
  // matters for fields the schema normalizes: title and affected[].monitorId
  // are trimmed, so this must compare against the same trimmed values the
  // real write persists.
  const patch = parseStatusReportPatch(body);
  if (!patch) return false;
  if ("title" in patch && patch.title !== current.title) return false;
  if ("startsAt" in patch && !sameInstant(patch.startsAt, current.startsAt)) return false;
  if ("endsAt" in patch && !sameInstant(patch.endsAt, current.endsAt)) return false;
  if ("affected" in patch && patch.affected) {
    const requested = new Set(patch.affected.map((entry) => `${entry.monitorId}:${entry.impact}`));
    const actual = new Set(current.affected.map((entry) => `${entry.monitorId}:${entry.impact}`));
    if (requested.size !== actual.size) return false;
    for (const key of requested) if (!actual.has(key)) return false;
  }
  return true;
}

/** `value` is patchSchema's already-parsed Date (or null/undefined when the caller omitted the field). */
function sameInstant(value: Date | null | undefined, current: string | null): boolean {
  if (value === undefined) return true;
  if (value === null) return current === null;
  return current !== null && value.getTime() === Date.parse(current);
}

/**
 * Report mutations invalidate the public status page, the report's
 * permalink, and the group pages of the affected monitors so updates appear
 * immediately instead of at the 30 s ISR boundary.
 *
 * Group pages match a report by monitor id OR live group name, so beyond the
 * snapshotted group names we also revalidate the CURRENT registry groups of
 * every monitor that is (or was) affected: the union of the post-patch
 * affected set and the caller-supplied pre-patch rows (one findMonitors
 * query, best-effort), so a monitor that was REMOVED from the affected set
 * but has since moved groups still gets its current group page refreshed,
 * not just the page its stale snapshot pointed at.
 */
export async function revalidateStatusReportPaths(
  report: {
    id: string;
    affected: ReadonlyArray<{ monitorId: string; groupName: string | null }>;
  },
  previousAffected: ReadonlyArray<{ monitorId: string; groupName: string | null }> = [],
): Promise<void> {
  revalidatePath("/status");
  revalidatePath(`/status/reports/${report.id}`);
  const combined = [...report.affected, ...previousAffected];
  const slugs = new Set(combined.map((entry) => statusGroupSlug(entry.groupName ?? "Other")));
  const monitorIds = [...new Set(combined.map((entry) => entry.monitorId))];
  if (monitorIds.length > 0) {
    try {
      const live = await databaseStatusReportsStore.findMonitors(monitorIds);
      for (const monitor of live) slugs.add(statusGroupSlug(monitor.groupName ?? "Other"));
    } catch {
      // Revalidation is best-effort. The snapshot slugs above still ran and
      // the 30 s ISR window bounds any staleness.
    }
  }
  for (const slug of slugs) {
    if (slug) revalidatePath(`/status/${slug}`);
  }
}
