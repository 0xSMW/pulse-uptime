import { describe, expect, it } from "vitest";

import {
  deriveOverallState,
  excludePromotedIncidents,
  filterReportsForGroup,
  monitorReportAnnotations,
  promotedIncidentIds,
  publicReportPhase,
  reportBannerTier,
  reportDurationSeconds,
  reportImpactLabels,
  reportStatusLabels,
  statusReportUrl,
  type PublicReportEntry,
  type ReportImpact,
  type ReportKind,
} from "./reports-display";

function report(overrides: {
  id?: string;
  type?: ReportKind;
  originIncidentId?: string | null;
  affected?: Array<{ monitorId: string; groupName?: string | null; impact?: ReportImpact }>;
} = {}): Pick<PublicReportEntry, "id" | "type" | "originIncidentId" | "affected"> {
  return {
    id: overrides.id ?? "rep-1",
    type: overrides.type ?? "incident",
    originIncidentId: overrides.originIncidentId ?? null,
    affected: (overrides.affected ?? []).map((entry, index) => ({
      monitorId: entry.monitorId,
      monitorName: `Name ${index}`,
      groupName: entry.groupName ?? null,
      impact: entry.impact ?? "degraded",
    })),
  };
}

describe("reportBannerTier", () => {
  it("floors incident reports at degraded, even with no affected services", () => {
    expect(reportBannerTier(report())).toBe("degraded");
    expect(reportBannerTier(report({ affected: [{ monitorId: "a", impact: "degraded" }] }))).toBe("degraded");
  });

  it("escalates incident reports to outage on any down impact", () => {
    expect(
      reportBannerTier(report({
        affected: [
          { monitorId: "a", impact: "degraded" },
          { monitorId: "b", impact: "down" },
        ],
      })),
    ).toBe("outage");
  });

  it("keeps maintenance reports at the maintenance tint, even with down impact", () => {
    // Downtime inside a maintenance window is expected, not an outage.
    expect(reportBannerTier(report({ type: "maintenance", affected: [{ monitorId: "a", impact: "down" }] }))).toBe("maintenance");
  });
});

describe("deriveOverallState", () => {
  const up = ["UP", "UP"];

  it("keeps the machine-only tiers intact without reports", () => {
    expect(deriveOverallState([], [])).toBe("empty");
    expect(deriveOverallState(up, [])).toBe("operational");
    expect(deriveOverallState(["UP", "VERIFYING_DOWN"], [])).toBe("investigating");
    expect(deriveOverallState(["UP", "VERIFYING_UP"], [])).toBe("investigating");
    expect(deriveOverallState(["UP", "DOWN"], [])).toBe("outage");
  });

  it("stays empty only when there are neither monitors nor ongoing reports", () => {
    expect(deriveOverallState([], [])).toBe("empty");
  });

  it("folds an ongoing report's tier in even with zero monitors (finding: used to stay \"empty\" regardless of reports, hiding an ongoing outage/maintenance report authored on a page with no enabled monitors)", () => {
    expect(deriveOverallState([], [report({ affected: [{ monitorId: "a", impact: "down" }] })])).toBe("outage");
    expect(deriveOverallState([], [report({ affected: [{ monitorId: "a", impact: "degraded" }] })])).toBe("degraded");
    expect(deriveOverallState([], [report({ type: "maintenance", affected: [{ monitorId: "a", impact: "maintenance" }] })])).toBe("maintenance");
  });

  it("yields Degraded Performance from a degraded-impact report over all-UP machines", () => {
    expect(deriveOverallState(up, [report({ affected: [{ monitorId: "a", impact: "degraded" }] })])).toBe("degraded");
  });

  it("maps down impact to the outage tier", () => {
    expect(deriveOverallState(up, [report({ affected: [{ monitorId: "a", impact: "down" }] })])).toBe("outage");
  });

  it("tints maintenance only when nothing redder is happening", () => {
    const maintenance = report({ type: "maintenance", affected: [{ monitorId: "a", impact: "maintenance" }] });
    expect(deriveOverallState(up, [maintenance])).toBe("maintenance");
    expect(deriveOverallState(["UP", "VERIFYING_DOWN"], [maintenance])).toBe("investigating");
    expect(deriveOverallState(["UP", "DOWN"], [maintenance])).toBe("outage");
  });

  it("lets the machine state win when redder than the report", () => {
    const degraded = report({ affected: [{ monitorId: "a", impact: "degraded" }] });
    expect(deriveOverallState(["DOWN"], [degraded])).toBe("outage");
    // A human-confirmed degradation outranks an unconfirmed verifying blip.
    expect(deriveOverallState(["UP", "VERIFYING_DOWN"], [degraded])).toBe("degraded");
  });

  it("takes the worst tier across multiple ongoing reports", () => {
    expect(
      deriveOverallState(up, [
        report({ type: "maintenance" }),
        report({ affected: [{ monitorId: "a", impact: "down" }] }),
      ]),
    ).toBe("outage");
  });
});

describe("filterReportsForGroup", () => {
  const groupMonitors = [
    { id: "api-prod", groupName: "APIs" },
    { id: "worker", groupName: null },
  ];

  it("keeps reports matching a monitor id in the group", () => {
    const matching = report({ affected: [{ monitorId: "api-prod", groupName: "Old Group" }] });
    expect(filterReportsForGroup([matching], groupMonitors)).toEqual([matching]);
  });

  it("keeps reports matching the snapshotted group name", () => {
    const matching = report({ affected: [{ monitorId: "api-archived", groupName: "APIs" }] });
    expect(filterReportsForGroup([matching], groupMonitors)).toEqual([matching]);
  });

  it("collapses null group names to the Other bucket", () => {
    const matching = report({ affected: [{ monitorId: "gone", groupName: null }] });
    expect(filterReportsForGroup([matching], groupMonitors)).toEqual([matching]);
    expect(filterReportsForGroup([matching], [{ id: "api-prod", groupName: "APIs" }])).toEqual([]);
  });

  it("drops reports with no overlap and reports with no affected services", () => {
    const other = report({ affected: [{ monitorId: "db", groupName: "Databases" }] });
    expect(filterReportsForGroup([other, report()], groupMonitors)).toEqual([]);
  });
});

describe("promotion dedupe", () => {
  const incidents = [{ id: "inc-1" }, { id: "inc-2" }, { id: "inc-3" }];

  it("collects origin incident ids from published reports", () => {
    const ids = promotedIncidentIds([
      report({ originIncidentId: "inc-1" }),
      report({ originIncidentId: null }),
      report({ originIncidentId: "inc-3" }),
    ]);
    expect([...ids].sort()).toEqual(["inc-1", "inc-3"]);
  });

  it("suppresses incidents represented by a report and keeps the rest", () => {
    const promoted = new Set(["inc-2"]);
    expect(excludePromotedIncidents(incidents, promoted).map((incident) => incident.id)).toEqual(["inc-1", "inc-3"]);
  });

  it("passes everything through when nothing was promoted", () => {
    expect(excludePromotedIncidents(incidents, new Set())).toEqual(incidents);
  });
});

describe("monitorReportAnnotations", () => {
  it("annotates each affected monitor with its impact label and report id", () => {
    const annotations = monitorReportAnnotations([
      report({
        id: "rep-a",
        affected: [
          { monitorId: "api", impact: "degraded" },
          { monitorId: "web", impact: "down" },
        ],
      }),
      report({ id: "rep-b", type: "maintenance", affected: [{ monitorId: "batch", impact: "maintenance" }] }),
    ]);
    expect(annotations.get("api")).toEqual({ reportId: "rep-a", impact: "degraded", label: "Degraded — see report" });
    expect(annotations.get("web")).toEqual({ reportId: "rep-a", impact: "down", label: "Down — see report" });
    expect(annotations.get("batch")).toEqual({ reportId: "rep-b", impact: "maintenance", label: "Maintenance — see report" });
    expect(annotations.get("unrelated")).toBeUndefined();
  });

  it("keeps the worst impact when several ongoing reports affect one monitor", () => {
    const annotations = monitorReportAnnotations([
      report({ id: "rep-a", affected: [{ monitorId: "api", impact: "down" }] }),
      report({ id: "rep-b", affected: [{ monitorId: "api", impact: "degraded" }] }),
    ]);
    expect(annotations.get("api")).toMatchObject({ reportId: "rep-a", impact: "down" });
  });
});

describe("publicReportPhase", () => {
  const now = new Date("2026-07-18T12:00:00.000Z");
  const base = {
    type: "maintenance" as const,
    startsAt: "2026-07-18T10:00:00.000Z",
    endsAt: null as string | null,
    resolvedAt: null as string | null,
    currentStatus: "in_progress" as const,
  };

  it("resolved wins over everything", () => {
    expect(publicReportPhase({ ...base, resolvedAt: "2026-07-18T11:00:00.000Z" }, now)).toBe("resolved");
  });

  it("classifies future maintenance as upcoming", () => {
    expect(publicReportPhase({ ...base, startsAt: "2026-07-19T10:00:00.000Z" }, now)).toBe("upcoming");
  });

  it("classifies a started-but-still-scheduled maintenance window as ongoing, matching the SQL active-bucket ranking (finding: classification vs SQL cap mismatch)", () => {
    // base.startsAt is already in the past relative to `now`: the window has
    // started even though the operator never posted an in_progress update.
    expect(publicReportPhase({ ...base, currentStatus: "scheduled" }, now)).toBe("ongoing");
  });

  it("still classifies a future-scheduled window as upcoming (startsAt has not arrived yet)", () => {
    expect(
      publicReportPhase({ ...base, currentStatus: "scheduled", startsAt: "2026-07-19T10:00:00.000Z" }, now),
    ).toBe("upcoming");
  });

  it("demotes a window past endsAt with no completing update", () => {
    expect(publicReportPhase({ ...base, endsAt: "2026-07-18T11:30:00.000Z" }, now)).toBe("window_ended");
  });

  it("keeps an open started maintenance window ongoing", () => {
    expect(publicReportPhase(base, now)).toBe("ongoing");
    expect(publicReportPhase({ ...base, endsAt: "2026-07-18T13:00:00.000Z" }, now)).toBe("ongoing");
  });

  it("treats unresolved incident reports as ongoing regardless of window", () => {
    expect(
      publicReportPhase(
        { ...base, type: "incident", currentStatus: "monitoring", endsAt: "2026-07-18T11:00:00.000Z" },
        now,
      ),
    ).toBe("ongoing");
  });

  it("classifies a future-dated incident report as upcoming, not ongoing (finding: future incidents leaked into the ongoing banner)", () => {
    expect(
      publicReportPhase(
        { ...base, type: "incident", currentStatus: "investigating", startsAt: "2026-07-19T10:00:00.000Z" },
        now,
      ),
    ).toBe("upcoming");
  });
});

describe("permalink helpers", () => {
  it("computes resolved report duration from start to resolution", () => {
    expect(
      reportDurationSeconds({ startsAt: "2026-07-18T10:00:00.000Z", resolvedAt: "2026-07-18T11:30:00.000Z" }),
    ).toBe(5_400);
    expect(reportDurationSeconds({ startsAt: "2026-07-18T10:00:00.000Z", resolvedAt: null })).toBe(0);
  });

  it("labels every update status and impact", () => {
    expect(reportStatusLabels.in_progress).toBe("In progress");
    expect(reportStatusLabels.investigating).toBe("Investigating");
    expect(reportImpactLabels.down).toBe("Down");
  });

  it("builds the public permalink route", () => {
    expect(statusReportUrl("rep-1")).toBe("/status/reports/rep-1");
  });
});
