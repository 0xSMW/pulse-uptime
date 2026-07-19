/**
 * Pure display helpers for public status reports. Like display.ts these
 * carry no server-only marker: deterministic functions shared by the public
 * page RSCs and unit tests. The structural types mirror the serialized shape
 * of PublicStatusReport in lib/api/status-reports.ts (string timestamps).
 */

export type ReportImpact = "down" | "degraded" | "maintenance";
export type ReportKind = "incident" | "maintenance";
export type ReportUpdateStatus =
  | "investigating"
  | "identified"
  | "monitoring"
  | "resolved"
  | "scheduled"
  | "in_progress"
  | "completed";
export type ReportPhase = "ongoing" | "upcoming" | "window_ended" | "resolved";

export type PublicReportEntry = {
  id: string;
  type: ReportKind;
  title: string;
  startsAt: string;
  endsAt: string | null;
  publishedAt: string;
  resolvedAt: string | null;
  originIncidentId: string | null;
  currentStatus: ReportUpdateStatus;
  phase: ReportPhase;
  latestUpdate: {
    id: string;
    status: ReportUpdateStatus;
    markdown: string;
    publishedAt: string;
  } | null;
  affected: Array<{
    monitorId: string;
    monitorName: string;
    groupName: string | null;
    impact: ReportImpact;
  }>;
};

export type PublicReportsView = {
  ongoing: PublicReportEntry[];
  upcoming: PublicReportEntry[];
  windowEnded: PublicReportEntry[];
  resolved: PublicReportEntry[];
};

export const reportStatusLabels: Record<ReportUpdateStatus, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
};

export const reportImpactLabels: Record<ReportImpact, string> = {
  down: "Down",
  degraded: "Degraded",
  maintenance: "Maintenance",
};

/**
 * Overall banner tiers ordered by severity: a machine
 * DOWN always outranks report-driven tiers, and an ongoing maintenance report
 * only tints the banner when nothing redder is happening. Degraded ranks above
 * investigating: a human-confirmed degradation outranks an unconfirmed blip.
 */
export type PublicOverallState =
  | "empty"
  | "operational"
  | "maintenance"
  | "investigating"
  | "degraded"
  | "outage";

const overallSeverity: Record<PublicOverallState, number> = {
  empty: 0,
  operational: 0,
  maintenance: 1,
  investigating: 2,
  degraded: 3,
  outage: 4,
};

function worse(left: PublicOverallState, right: PublicOverallState): PublicOverallState {
  return overallSeverity[right] > overallSeverity[left] ? right : left;
}

/**
 * The banner tier one ongoing published report contributes. Incident reports
 * floor at "degraded" (an ongoing incident report must never sit under a green
 * banner) and escalate to "outage" when any affected service is down.
 * Maintenance reports always contribute the maintenance tint; downtime inside
 * a maintenance window is expected, not an outage.
 */
export function reportBannerTier(
  report: Pick<PublicReportEntry, "type" | "affected">,
): "maintenance" | "degraded" | "outage" {
  if (report.type === "maintenance") return "maintenance";
  return report.affected.some((entry) => entry.impact === "down") ? "outage" : "degraded";
}

/**
 * Overall state: machine states derive the existing
 * empty/operational/investigating/outage tiers; published ongoing reports add
 * degraded/maintenance/outage tiers; the reddest wins.
 *
 * "empty" only when there are NEITHER monitors NOR ongoing reports: a page
 * with zero enabled monitors must never short-circuit to "empty" without
 * looking at ongoingReports, which would hide a manually authored (or
 * promoted-then-archived-monitor) ongoing outage/maintenance report behind a
 * neutral banner. With no monitors but at least one ongoing report, the
 * machine-derived floor is "operational" so the report's own tier (degraded /
 * maintenance / outage) is free to raise it.
 */
export function deriveOverallState(
  machineStates: readonly string[],
  ongoingReports: ReadonlyArray<Pick<PublicReportEntry, "type" | "affected">>,
): PublicOverallState {
  if (machineStates.length === 0 && ongoingReports.length === 0) return "empty";
  let overall: PublicOverallState = machineStates.length === 0
    ? "operational"
    : machineStates.includes("DOWN")
      ? "outage"
      : machineStates.some((state) => state === "VERIFYING_DOWN" || state === "VERIFYING_UP")
        ? "investigating"
        : "operational";
  for (const report of ongoingReports) {
    overall = worse(overall, reportBannerTier(report));
  }
  return overall;
}

/**
 * A report appears on /status/[group] iff it affects a monitor in that group,
 * matched by live monitor id or snapshotted group name. Null group names
 * collapse to the "Other" bucket exactly as the page groups them.
 */
export function filterReportsForGroup<T extends Pick<PublicReportEntry, "affected">>(
  reports: readonly T[],
  groupMonitors: ReadonlyArray<{ id: string; groupName: string | null }>,
): T[] {
  const monitorIds = new Set(groupMonitors.map((monitor) => monitor.id));
  const groupNames = new Set(groupMonitors.map((monitor) => monitor.groupName ?? "Other"));
  return reports.filter((report) =>
    report.affected.some(
      (entry) => monitorIds.has(entry.monitorId) || groupNames.has(entry.groupName ?? "Other"),
    ),
  );
}

/** Incident ids already represented by a published report (dedupe). */
export function promotedIncidentIds(
  reports: ReadonlyArray<Pick<PublicReportEntry, "originIncidentId">>,
): Set<string> {
  const ids = new Set<string>();
  for (const report of reports) {
    if (report.originIncidentId) ids.add(report.originIncidentId);
  }
  return ids;
}

export function excludePromotedIncidents<T extends { id: string }>(
  incidents: readonly T[],
  promoted: ReadonlySet<string>,
): T[] {
  if (promoted.size === 0) return [...incidents];
  return incidents.filter((incident) => !promoted.has(incident.id));
}

export type MonitorReportAnnotation = {
  reportId: string;
  impact: ReportImpact;
  label: string;
};

const annotationLabels: Record<ReportImpact, string> = {
  down: "Down — see report",
  degraded: "Degraded — see report",
  maintenance: "Maintenance — see report",
};

const impactSeverity: Record<ReportImpact, number> = { maintenance: 0, degraded: 1, down: 2 };

/**
 * Row annotations while a report is ongoing: monitor id → the worst declared
 * impact across ongoing reports. The annotation supplements the machine state
 * dot, never overrides it.
 */
export function monitorReportAnnotations(
  ongoingReports: ReadonlyArray<Pick<PublicReportEntry, "id" | "affected">>,
): Map<string, MonitorReportAnnotation> {
  const annotations = new Map<string, MonitorReportAnnotation>();
  for (const report of ongoingReports) {
    for (const entry of report.affected) {
      const existing = annotations.get(entry.monitorId);
      if (existing && impactSeverity[existing.impact] >= impactSeverity[entry.impact]) continue;
      annotations.set(entry.monitorId, {
        reportId: report.id,
        impact: entry.impact,
        label: annotationLabels[entry.impact],
      });
    }
  }
  return annotations;
}

/**
 * Phase for the permalink page, mirroring classifyPublicReport in
 * lib/api/status-reports.ts on the serialized (string-timestamp) shape:
 * upcoming = startsAt > now for EITHER report type; a maintenance window past
 * endsAt with no completing update is "window_ended"; resolved wins over
 * everything.
 *
 * The latest update's status must never move a started window back to
 * "upcoming": a started, non-completed window is ongoing regardless of
 * whether anyone posted an in_progress update, so this must agree with the
 * SQL active-bucket ranking in getPublicReportRows, which ranks a started
 * window as active independent of the operator having posted anything.
 */
export function publicReportPhase(
  report: {
    type: ReportKind;
    startsAt: string;
    endsAt: string | null;
    resolvedAt: string | null;
  },
  now: Date,
): ReportPhase {
  if (report.resolvedAt) return "resolved";
  if (Date.parse(report.startsAt) > now.getTime()) return "upcoming";
  if (report.type === "maintenance" && report.endsAt && Date.parse(report.endsAt) <= now.getTime()) {
    return "window_ended";
  }
  return "ongoing";
}

/** Duration of a resolved report for the history list (start → resolution). */
export function reportDurationSeconds(report: { startsAt: string; resolvedAt: string | null }): number {
  if (!report.resolvedAt) return 0;
  return Math.max(0, Math.floor((Date.parse(report.resolvedAt) - Date.parse(report.startsAt)) / 1_000));
}

/** Public permalink route for a report id. */
export function statusReportUrl(reportId: string): string {
  return `/status/reports/${encodeURIComponent(reportId)}`;
}
