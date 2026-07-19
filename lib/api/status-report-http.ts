import "server-only";

import { revalidatePath } from "next/cache";

import type { DatabaseHandle } from "@/lib/db/client";
import { statusGroupSlug } from "@/lib/reporting/queries/timeline";

import { apiError, apiJson, errorEnvelope, objectEnvelope } from "./envelopes";
import { executeIdempotent, type StoredResponse } from "./idempotency";
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
 * Runs one idempotent status-report mutation end to end: acquires the
 * idempotency record (or replays a completed one), runs `work` inside a
 * database transaction shared with the idempotency completion write, wraps
 * the domain result in the standard object envelope, and maps everything
 * onto an HTTP Response. Every mutation route in the status-reports/
 * incidents-promote family is authorize() → parse params/body → one call
 * here with a route-specific `work` closure.
 *
 * `work` receives the open transaction handle and returns the eventual
 * `{ status, kind, data }`, or throws StatusReportError. Two invariants this
 * helper owns on every call, so route files don't have to restate them:
 *
 * - The mutation and the idempotency completion commit together, in the
 *   SAME transaction (via context.transaction inside executeIdempotent). If
 *   `work` throws anything OTHER than StatusReportError, the transaction
 *   rolls back both the mutation and the completion, so the record is left
 *   running: truthfully, nothing committed, and a retry reruns `work` from
 *   scratch rather than trying to recover a state that never existed.
 * - A StatusReportError thrown by `work` is caught HERE, INSIDE the same
 *   transaction, and recorded as the operation's own completed response (via
 *   storedStatusReportError) instead of rolling back. A deterministic domain
 *   error (bad input, not-found, a conflict like ALREADY_PUBLISHED) is a
 *   real outcome of this operation, not evidence it never ran, and every
 *   status-reports store method guards before mutating (returning a
 *   sentinel or throwing before any write), so committing "no mutation, this
 *   response" alongside the error is always correct.
 */
export async function runStatusReportMutation<T>(input: {
  request: Request;
  context: { principalKey: string; requestId: string };
  routeKey: string;
  body: unknown;
  work: (tx: DatabaseHandle, context: { operationId: string }) => Promise<MutationOutcome<T>>;
}): Promise<Response> {
  const { request, context, routeKey, body, work } = input;
  try {
    const result = await executeIdempotent({
      request,
      principalKey: context.principalKey,
      routeKey,
      body,
      work: async (idempotencyContext) => idempotencyContext.transaction(async (tx) => {
        try {
          const outcome = await work(tx, idempotencyContext);
          return { status: outcome.status, body: objectEnvelope(outcome.kind, outcome.data, context.requestId) };
        } catch (error) {
          if (error instanceof StatusReportError) return storedStatusReportError(error, context.requestId);
          throw error;
        }
      }),
    });
    return apiJson(result.body, { status: result.status });
  } catch (error) {
    return statusReportRouteError(error, context.requestId);
  }
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
