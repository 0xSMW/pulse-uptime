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

// Every OverallBanner tier label (§overall-banner.tsx) — none of these should
// appear when the page is rendering the degraded "unavailable" shell.
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
