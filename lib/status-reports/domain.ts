import { statusGroupSlug } from "@/lib/reporting/queries/timeline"

/**
 * Pure, client-safe status-report vocabulary: the type/update-status/impact
 * literals, their labels, the per-type status ordering, the resolving-status
 * test, the per-type impact vocabulary, and the slug-based group filter. No
 * server-only marker and no database imports, so the server service
 * (lib/api/status-reports.ts), its reporting reads (lib/status-reports/queries.ts),
 * and client components (components/incidents/report-status.ts) share one
 * source of truth instead of keeping divergent copies.
 */

export type ReportType = "incident" | "maintenance"

export type ReportUpdateStatus =
  | "investigating"
  | "identified"
  | "monitoring"
  | "resolved"
  | "scheduled"
  | "in_progress"
  | "completed"

export type ReportImpact = "down" | "degraded" | "maintenance"

/** Ordered update-status vocabulary per report type. */
export const INCIDENT_UPDATE_STATUSES = [
  "investigating",
  "identified",
  "monitoring",
  "resolved",
] as const
export const MAINTENANCE_UPDATE_STATUSES = [
  "scheduled",
  "in_progress",
  "completed",
] as const

/** Per-type ordered status lists, keyed by report type. */
export const REPORT_STATUSES: Record<
  ReportType,
  readonly [ReportUpdateStatus, ...ReportUpdateStatus[]]
> = {
  incident: INCIDENT_UPDATE_STATUSES,
  maintenance: MAINTENANCE_UPDATE_STATUSES,
}

export const REPORT_STATUS_LABELS: Record<ReportUpdateStatus, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
}

/** The statuses whose position as the latest update resolves a report. */
export const RESOLVING_STATUSES: readonly ReportUpdateStatus[] = [
  "resolved",
  "completed",
]

export function isResolvingStatus(status: ReportUpdateStatus): boolean {
  return RESOLVING_STATUSES.includes(status)
}

/**
 * Per-type impact vocabulary: incidents offer down/degraded, maintenance
 * windows offer maintenance/degraded, neither type exposes the other's
 * exclusive impact. A non-UI client (API/CLI) enforces this too so it can't
 * persist a contradictory pairing that would render a nonsensical label.
 */
export const IMPACT_BY_TYPE: Record<ReportType, readonly ReportImpact[]> = {
  incident: ["down", "degraded"],
  maintenance: ["maintenance", "degraded"],
}

/** Impact picker options for the report editor, scoped to the report type. */
export function impactOptions(
  type: ReportType
): Array<{ value: ReportImpact | "none"; label: string }> {
  if (type === "incident") {
    return [
      { value: "none", label: "Not affected" },
      { value: "degraded", label: "Degraded" },
      { value: "down", label: "Down" },
    ]
  }
  return [
    { value: "none", label: "Not affected" },
    { value: "maintenance", label: "Maintenance" },
    { value: "degraded", label: "Degraded" },
  ]
}

/**
 * A report belongs on /status/[group] iff it affects that group, matched by a
 * currently visible monitor id or by the SLUG of the snapshotted group name.
 * Slug matching (not exact-name matching against visible monitors) is what
 * keeps a report reachable when every monitor it affected has since been
 * archived: the affected rows still carry the group-name snapshot, and its
 * slug is exactly what the URL segment encodes. Null snapshot group names
 * collapse to the "Other" bucket exactly as the page groups live monitors.
 */
export function filterReportsForGroup<
  T extends {
    affected: ReadonlyArray<{ monitorId: string; groupName: string | null }>
  },
>(
  reports: readonly T[],
  {
    slug,
    visibleMonitorIds,
  }: { slug: string; visibleMonitorIds: ReadonlySet<string> }
): T[] {
  return reports.filter((report) =>
    report.affected.some(
      (entry) =>
        visibleMonitorIds.has(entry.monitorId) ||
        statusGroupSlug(entry.groupName ?? "Other") === slug
    )
  )
}
