import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { StatusPageContent, type PublicStatusData } from "./status-page-content";

const baseConfig: PublicStatusData["config"] = {
  layout: "vertical",
  theme: "system",
  logoLightImageId: null,
  logoDarkImageId: null,
  homepageUrl: null,
  contactUrl: null,
  navLinks: [],
  historyDays: 90,
  uptimeDecimals: 2,
  timezone: null,
  announcementMarkdown: null,
};

const unavailableData: PublicStatusData = {
  pageName: "Pulse Status",
  lastUpdatedAt: "2026-07-18T12:00:00.000Z",
  overallState: "empty",
  unavailable: true,
  config: baseConfig,
  reports: { ongoing: [], upcoming: [], windowEnded: [], resolved: [] },
  currentIncidents: [],
  groups: [],
  recentIncidents: [],
};

const operationalData: PublicStatusData = {
  ...unavailableData,
  unavailable: false,
  overallState: "operational",
  groups: [
    {
      name: "Web",
      slug: "web",
      monitors: [
        { id: "mon-1", name: "API", state: "UP", uptime: 99.98, timeline: [] },
      ],
    },
  ],
};

// Every OverallBanner tier label (see overall-banner.tsx): none of these
// should appear when the page is rendering the degraded "unavailable" shell.
const overallBannerLabels = [
  "All Systems Operational",
  "Investigating",
  "Degraded Performance",
  "Maintenance in Progress",
  "Major Outage",
  "No Monitors Configured",
];

describe("StatusPageContent", () => {
  it("renders the neutral unavailable notice, the page shell, and no monitor/report sections", () => {
    const html = renderToStaticMarkup(<StatusPageContent data={unavailableData} />);

    expect(html).toContain("Pulse Status");
    expect(html).toContain("Status information is temporarily unavailable");
    expect(html).toContain("refresh in a moment");

    // No outage banner or any other overall-state tint.
    for (const label of overallBannerLabels) {
      expect(html).not.toContain(label);
    }
    // No monitor/report sections at all.
    expect(html).not.toContain("Systems");
    expect(html).not.toContain("Recent Incidents");
    expect(html).not.toContain("Scheduled Maintenance");
  });

  it("still renders the ← All Systems link on a group page while unavailable (no 404)", () => {
    const html = renderToStaticMarkup(<StatusPageContent data={unavailableData} groupView />);
    expect(html).toContain("All Systems");
    expect(html).toContain("Status information is temporarily unavailable");
  });

  it("renders the normal banner and monitor sections when the data is available", () => {
    const html = renderToStaticMarkup(<StatusPageContent data={operationalData} />);
    expect(html).toContain("All Systems Operational");
    expect(html).toContain("API");
    expect(html).not.toContain("Status information is temporarily unavailable");
  });

  it("keeps the maintenance-specific heading when only maintenance windows are scheduled", () => {
    const data: PublicStatusData = {
      ...operationalData,
      reports: {
        ...operationalData.reports,
        upcoming: [{
          id: "rep-maint", type: "maintenance", title: "DB upgrade",
          startsAt: "2026-07-19T00:00:00.000Z", endsAt: "2026-07-19T02:00:00.000Z",
          publishedAt: "2026-07-18T09:00:00.000Z", resolvedAt: null, originIncidentId: null,
          currentStatus: "scheduled", phase: "upcoming", latestUpdate: null, affected: [],
        }],
      },
    };
    const html = renderToStaticMarkup(<StatusPageContent data={data} />);
    expect(html).toContain("Scheduled Maintenance");
    expect(html).not.toContain("Scheduled Reports");
  });

  it("computes each row's own DST offset instead of reusing the offset from lastUpdatedAt (finding: rows on the other side of a DST boundary showed the wrong offset label)", () => {
    // lastUpdatedAt sits in EDT (GMT-4, after the 2026-03-08 spring-forward).
    // A page-level offset computed once there and reused for every row would
    // mislabel the resolved report that started back in EST (GMT-5).
    const data: PublicStatusData = {
      ...operationalData,
      lastUpdatedAt: "2026-07-18T12:00:00.000Z",
      config: { ...baseConfig, timezone: "America/New_York" },
      reports: {
        ...operationalData.reports,
        resolved: [
          {
            id: "rep-before-dst", type: "incident", title: "Before DST",
            startsAt: "2026-03-01T12:00:00.000Z", endsAt: null,
            publishedAt: "2026-03-01T12:00:00.000Z", resolvedAt: "2026-03-01T13:00:00.000Z",
            originIncidentId: null, currentStatus: "resolved", phase: "resolved", latestUpdate: null, affected: [],
          },
          {
            id: "rep-after-dst", type: "incident", title: "After DST",
            startsAt: "2026-03-15T12:00:00.000Z", endsAt: null,
            publishedAt: "2026-03-15T12:00:00.000Z", resolvedAt: "2026-03-15T13:00:00.000Z",
            originIncidentId: null, currentStatus: "resolved", phase: "resolved", latestUpdate: null, affected: [],
          },
        ],
      },
    };
    const html = renderToStaticMarkup(<StatusPageContent data={data} />);
    expect(html).toContain("GMT-5"); // Before DST: EST
    expect(html).toContain("GMT-4"); // After DST: EDT (also lastUpdatedAt's own offset)
  });

  it("sorts Recent Incidents by resolved time, not start time (finding: the resolved-reports feed is capped to the 10 most-recently-RESOLVED, so re-sorting the survivors by start time here made the display inconsistent with what the cap actually kept)", () => {
    const data: PublicStatusData = {
      ...operationalData,
      reports: {
        ...operationalData.reports,
        // Started long ago but resolved most recently.
        resolved: [{
          id: "rep-long-running", type: "incident", title: "Long-running report",
          startsAt: "2026-01-01T00:00:00.000Z", endsAt: null,
          publishedAt: "2026-01-01T00:00:00.000Z", resolvedAt: "2026-07-18T12:00:00.000Z",
          originIncidentId: null, currentStatus: "resolved", phase: "resolved", latestUpdate: null, affected: [],
        }],
      },
      // Started recently but resolved before the report above.
      recentIncidents: [{
        id: "inc-recent-start", monitorName: "Legacy Worker", openedAt: "2026-07-18T10:00:00.000Z",
        resolvedAt: "2026-07-18T10:30:00.000Z", durationSeconds: 1_800,
      }],
    };
    const html = renderToStaticMarkup(<StatusPageContent data={data} />);
    const reportIndex = html.indexOf("Long-running report");
    const incidentIndex = html.indexOf("Legacy Worker");
    expect(reportIndex).toBeGreaterThan(-1);
    expect(incidentIndex).toBeGreaterThan(-1);
    // The report resolved LATER (12:00) than the incident (10:30), so it must
    // render first even though it started far earlier (Jan 1 vs Jul 18).
    expect(reportIndex).toBeLessThan(incidentIndex);
  });

  it("generalizes the heading and per-row label when a future-dated incident is scheduled (finding: future incidents rendered as maintenance)", () => {
    const data: PublicStatusData = {
      ...operationalData,
      reports: {
        ...operationalData.reports,
        upcoming: [{
          id: "rep-incident", type: "incident", title: "Planned failover drill",
          startsAt: "2026-07-19T00:00:00.000Z", endsAt: null,
          publishedAt: "2026-07-18T09:00:00.000Z", resolvedAt: null, originIncidentId: null,
          currentStatus: "investigating", phase: "upcoming", latestUpdate: null, affected: [],
        }],
      },
    };
    const html = renderToStaticMarkup(<StatusPageContent data={data} />);
    expect(html).toContain("Scheduled Reports");
    expect(html).not.toContain("Scheduled Maintenance");
    expect(html).toContain("Planned failover drill");
    expect(html).toContain("Upcoming report");
  });
});
