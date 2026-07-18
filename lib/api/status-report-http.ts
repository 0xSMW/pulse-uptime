import "server-only";

import { revalidatePath } from "next/cache";

import { statusGroupSlug } from "@/lib/reporting/queries/timeline";

import { apiError } from "./envelopes";
import { routeError } from "./route";
import { databaseStatusReportsStore, StatusReportError } from "./status-reports";

/** Shared HTTP mapping for the status-reports route family. */
export function statusReportRouteError(error: unknown, requestId: string): Response {
  if (error instanceof StatusReportError) {
    const status = error.code === "VALIDATION_ERROR" || error.code === "INVALID_CURSOR"
      ? 400
      : error.code === "LAST_UPDATE" || error.code === "ALREADY_PUBLISHED"
        ? 409
        : 404;
    return apiError(requestId, status, error.code, error.message, error.details);
  }
  return routeError(error, requestId);
}

/**
 * §3.2: report mutations invalidate the public status page, the report's
 * permalink, and the group pages of the affected monitors so updates appear
 * immediately instead of at the 30 s ISR boundary.
 *
 * Group pages match a report by monitor id OR live group name, so beyond the
 * snapshotted group names we also revalidate the affected monitors' CURRENT
 * registry groups (one findMonitors query, best-effort), and callers replacing
 * the affected set pass the pre-patch rows so the pages a report just left are
 * refreshed too.
 */
export async function revalidateStatusReportPaths(
  report: {
    id: string;
    affected: ReadonlyArray<{ monitorId: string; groupName: string | null }>;
  },
  previousAffected: ReadonlyArray<{ groupName: string | null }> = [],
): Promise<void> {
  revalidatePath("/status");
  revalidatePath(`/status/reports/${report.id}`);
  const slugs = new Set(
    [...report.affected, ...previousAffected].map((entry) => statusGroupSlug(entry.groupName ?? "Other")),
  );
  const monitorIds = [...new Set(report.affected.map((entry) => entry.monitorId))];
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
