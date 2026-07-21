import "server-only"

import {
  classifyPublicReport,
  databaseStatusReportsStore,
  PUBLIC_RESOLVED_LIMIT,
  type PublicReports,
  type PublicReportsFilter,
  type PublicStatusReport,
  type StatusReportData,
  StatusReportError,
  type StatusReportsDependencies,
  serializeReport,
} from "@/lib/api/status-reports"
import { statusGroupSlug } from "@/lib/reporting/queries/timeline"

/**
 * Reporting-facing reads for the public status page. Split out of the API
 * mega-module so lib/reporting/queries/status.ts depends on the reporting
 * domain, not the mutation/store surface. The service still owns the store and
 * mutations and re-exports these two reads for its own callers.
 */

export type { PublicReports, StatusReportData }
export { StatusReportError }

/**
 * Single published or draft report by id, in the detailed serialized shape.
 * Throws REPORT_NOT_FOUND when the id is unknown or not a UUID.
 */
export async function requireStatusReport(
  id: string,
  dependencies: StatusReportsDependencies = {}
): Promise<StatusReportData> {
  const store = dependencies.store ?? databaseStatusReportsStore
  const report = await store.getReport(id)
  if (!report) {
    throw new StatusReportError(
      "REPORT_NOT_FOUND",
      "Status report was not found"
    )
  }
  const { updates, affected } = await store.getReportDetails([report.id])
  return serializeReport(report, updates, affected)
}

/**
 * Batched public read, exactly 3 queries: (1) published reports through
 * the partial indexes, (2) latest update per report via DISTINCT ON with the
 * contract total order, (3) affected rows. Drafts never appear.
 *
 * `filter` scopes query 1 to a single group's reports (via EXISTS against
 * status_report_affected) for /status/[group] pages, adding one small
 * distinct-names query up front to resolve the slug. The root page passes no
 * filter so its resolved LIMIT stays global. Queries 2 and 3 automatically
 * inherit the scoping since they only fan out over the ids query 1 returned.
 */
export async function getPublicReports(
  dependencies: StatusReportsDependencies = {},
  filter?: PublicReportsFilter
): Promise<PublicReports> {
  const store = dependencies.store ?? databaseStatusReportsStore
  const now = dependencies.now?.() ?? new Date()
  // Slug resolution happens in JS, never in SQL: statusGroupSlug's NFKD
  // normalization and punctuation folding have no portable SQL equivalent,
  // so the exact snapshot names whose slug matches are enumerated here and
  // the store compares raw strings against that list. By construction the
  // SQL prefilter then keeps exactly the affected rows the JS slug filter
  // (filterReportsForGroup in lib/status-reports/domain) would keep, so the row
  // caps inside getPublicReportRows apply after group scoping and can never
  // starve a group whose only reports are older than unrelated global history.
  const rowsFilter = filter
    ? {
        monitorIds: filter.monitorIds,
        groupNames: [
          ...new Set(
            (await store.getAffectedGroupNames()).map((name) => name ?? "Other")
          ),
        ].filter((name) => statusGroupSlug(name) === filter.groupSlug),
      }
    : undefined
  const rows = await store.getPublicReportRows({
    resolvedLimit: PUBLIC_RESOLVED_LIMIT,
    now,
    filter: rowsFilter,
  })
  const published = rows.filter((row) => row.publishedAt !== null)
  const ids = published.map((row) => row.id)
  const [latestUpdates, affected] =
    ids.length === 0
      ? [[], []]
      : await Promise.all([store.getLatestUpdates(ids), store.getAffected(ids)])
  const latestByReport = new Map(
    latestUpdates.map((update) => [update.reportId, update])
  )

  const result: PublicReports = {
    ongoing: [],
    upcoming: [],
    windowEnded: [],
    resolved: [],
  }
  for (const report of published) {
    const latest = latestByReport.get(report.id) ?? null
    const phase = classifyPublicReport(report, now)
    const entry: PublicStatusReport = {
      id: report.id,
      type: report.type,
      title: report.title,
      startsAt: report.startsAt.toISOString(),
      endsAt: report.endsAt?.toISOString() ?? null,
      publishedAt: report.publishedAt!.toISOString(),
      resolvedAt: report.resolvedAt?.toISOString() ?? null,
      originIncidentId: report.originIncidentId,
      currentStatus:
        latest?.status ??
        (report.type === "incident" ? "investigating" : "scheduled"),
      phase,
      latestUpdate: latest
        ? {
            id: latest.id,
            status: latest.status,
            markdown: latest.markdown,
            publishedAt: latest.publishedAt.toISOString(),
            createdAt: latest.createdAt.toISOString(),
          }
        : null,
      affected: affected
        .filter((row) => row.reportId === report.id)
        .sort((left, right) => left.monitorId.localeCompare(right.monitorId))
        .map((row) => ({
          monitorId: row.monitorId,
          monitorName: row.monitorName,
          groupName: row.groupName,
          impact: row.impact,
        })),
    }
    if (phase === "ongoing") {
      result.ongoing.push(entry)
    } else if (phase === "upcoming") {
      result.upcoming.push(entry)
    } else if (phase === "window_ended") {
      result.windowEnded.push(entry)
    } else {
      result.resolved.push(entry)
    }
  }
  result.ongoing.sort((left, right) =>
    right.startsAt.localeCompare(left.startsAt)
  )
  result.upcoming.sort((left, right) =>
    left.startsAt.localeCompare(right.startsAt)
  )
  result.windowEnded.sort((left, right) =>
    right.startsAt.localeCompare(left.startsAt)
  )
  result.resolved.sort((left, right) =>
    (right.resolvedAt ?? "").localeCompare(left.resolvedAt ?? "")
  )
  return result
}
