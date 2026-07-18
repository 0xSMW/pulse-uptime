import "server-only";

import { revalidatePath } from "next/cache";

import { statusGroupSlug } from "@/lib/reporting/queries/timeline";

import { apiError, errorEnvelope } from "./envelopes";
import type { StoredResponse } from "./idempotency";
import { routeError } from "./route";
import { databaseStatusReportsStore, StatusReportError } from "./status-reports";

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
 * Maps a StatusReportError to a StoredResponse (finding: publish's
 * ALREADY_PUBLISHED 409, and the REPORT_NOT_FOUND/UPDATE_NOT_FOUND/
 * LAST_UPDATE 404s/409 the report- and update-delete routes can throw, are
 * deterministic outcomes of CURRENT state — not proof this operation ever
 * ran. Letting them throw past executeIdempotent left the idempotency record
 * stuck "running" until a stale reclaim's recover callback saw the exact
 * state the failure described — already published, already gone — and
 * replayed it as a false 200. Callers should catch StatusReportError INSIDE
 * their idempotent work() and return this mapping instead of rethrowing, so
 * executeIdempotent records the genuine 409/404 as the operation's own
 * response: a retry with the same key then replays it verbatim via the
 * ordinary completed-record path, with no recover callback needed.
 */
export function storedStatusReportError(error: StatusReportError, requestId: string): StoredResponse {
  return { status: statusReportErrorStatus(error), body: errorEnvelope(error.code, error.message, requestId, error.details) };
}

/**
 * Idempotency recovery check for PATCH /status-reports/{id} (finding: a
 * committed patch + crash makes the retry rerun updateStatusReport and
 * re-snapshot renamed/moved monitors a second time). True when the CURRENT
 * report already reflects everything the caller asked to change:
 * title/startsAt/endsAt equal wherever the caller sent them (compared as
 * instants, tolerant of formatting), and affected — if sent — equal as a set
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
  if (body === null || typeof body !== "object") return false;
  const patch = body as Record<string, unknown>;
  if ("title" in patch && patch.title !== current.title) return false;
  if ("startsAt" in patch && !sameInstant(patch.startsAt, current.startsAt)) return false;
  if ("endsAt" in patch && !sameInstant(patch.endsAt, current.endsAt)) return false;
  if ("affected" in patch) {
    if (!Array.isArray(patch.affected)) return false;
    const requested = new Set(
      patch.affected.map((entry) => `${(entry as { monitorId: string }).monitorId}:${(entry as { impact: string }).impact}`),
    );
    const actual = new Set(current.affected.map((entry) => `${entry.monitorId}:${entry.impact}`));
    if (requested.size !== actual.size) return false;
    for (const key of requested) if (!actual.has(key)) return false;
  }
  return true;
}

function sameInstant(value: unknown, current: string | null): boolean {
  if (value === null) return current === null;
  if (typeof value !== "string" || current === null) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && parsed === Date.parse(current);
}

/**
 * §3.2: report mutations invalidate the public status page, the report's
 * permalink, and the group pages of the affected monitors so updates appear
 * immediately instead of at the 30 s ISR boundary.
 *
 * Group pages match a report by monitor id OR live group name, so beyond the
 * snapshotted group names we also revalidate the CURRENT registry groups of
 * every monitor that is (or was) affected — the union of the post-patch
 * affected set and the caller-supplied pre-patch rows (one findMonitors
 * query, best-effort) — so a monitor that was REMOVED from the affected set
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
      // Revalidation is best-effort; the snapshot slugs above still ran and
      // the 30 s ISR window bounds any staleness.
    }
  }
  for (const slug of slugs) {
    if (slug) revalidatePath(`/status/${slug}`);
  }
}
