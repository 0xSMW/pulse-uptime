/**
 * Pure display helpers for public status reports (§3.6). Like display.ts these
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
 * Overall banner tiers ordered by severity. "Redder wins" (§3.6): a machine
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
 * Maintenance reports always contribute the maintenance tint — downtime inside
 * a maintenance window is expected, not an outage.
 */
export function reportBannerTier(
  report: Pick<PublicReportEntry, "type" | "affected">,
): "maintenance" | "degraded" | "outage" {
  if (report.type === "maintenance") return "maintenance";
  return report.affected.some((entry) => entry.impact === "down") ? "outage" : "degraded";
}

/**
 * §3.6 overall state: machine states derive the existing
 * empty/operational/investigating/outage tiers; published ongoing reports feed
 * additional degraded/maintenance/outage tiers; the reddest wins.
 */
export function deriveOverallState(
  machineStates: readonly string[],
  ongoingReports: ReadonlyArray<Pick<PublicReportEntry, "type" | "affected">>,
): PublicOverallState {
  if (machineStates.length === 0) return "empty";
  let overall: PublicOverallState = machineStates.includes("DOWN")
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
 * matched by live monitor id or by the snapshotted group name (§3.6). Null
 * group names collapse to the "Other" bucket exactly as the page groups them.
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

/** Incident ids already represented by a published report (dedupe, §3.6). */
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
 * dot, never overrides it (§3.6).
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
 * upcoming = startsAt > now for EITHER report type (or a `scheduled` current
 * status); a maintenance window past endsAt with no completing update is
 * "window_ended"; resolved wins over everything.
 */
export function publicReportPhase(
  report: {
    type: ReportKind;
    startsAt: string;
    endsAt: string | null;
    resolvedAt: string | null;
    currentStatus: ReportUpdateStatus;
  },
  now: Date,
): ReportPhase {
  if (report.resolvedAt) return "resolved";
  if (Date.parse(report.startsAt) > now.getTime()) return "upcoming";
  if (report.type === "maintenance") {
    if (report.endsAt && Date.parse(report.endsAt) <= now.getTime()) return "window_ended";
    if (report.currentStatus === "scheduled") return "upcoming";
    return "ongoing";
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
