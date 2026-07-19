import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TimezoneProvider } from "@/components/dashboard/timezone-provider";
import { ReportFilters, reportsHref } from "./report-filters";
import { ReportList, ReportListPagination, ReportsEmpty } from "./report-list";
import type { ReportListRowData } from "./report-status";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/incidents/reports",
}));

const base: ReportListRowData = {
  id: "rep-1",
  type: "incident",
  title: "Elevated API error rates",
  publishedAt: "2026-07-18T10:05:00.000Z",
  currentStatus: "investigating",
  updatesCount: 1,
  latestUpdate: { status: "investigating", publishedAt: "2026-07-18T10:05:00.000Z" },
};

function renderList(reports: ReportListRowData[]) {
  return renderToStaticMarkup(
    <TimezoneProvider>
      <ReportList reports={reports} />
    </TimezoneProvider>,
  );
}

describe("ReportList", () => {
  it("renders title, status, update count, and latest time", () => {
    const html = renderList([base]);
    expect(html).toContain("Elevated API error rates");
    expect(html).toContain("Investigating");
    expect(html).toContain("1 update");
    expect(html).toContain('href="/incidents/reports/rep-1"');
    expect(html).not.toContain(">Draft<");
  });

  it("badges drafts and chips maintenance reports", () => {
    const html = renderList([
      {
        ...base,
        id: "rep-2",
        type: "maintenance",
        publishedAt: null,
        currentStatus: "scheduled",
        updatesCount: 2,
        latestUpdate: { status: "scheduled", publishedAt: "2026-07-18T10:05:00.000Z" },
      },
    ]);
    expect(html).toContain(">Draft<");
    expect(html).toContain(">Maintenance<");
    expect(html).toContain("2 updates");
    expect(html).toContain("Scheduled");
  });
});

describe("ReportsEmpty", () => {
  it("offers creation when unfiltered", () => {
    const html = renderToStaticMarkup(<ReportsEmpty filtered={false} />);
    expect(html).toContain("No status reports yet");
    expect(html).toContain('href="/incidents/reports/new"');
  });

  it("explains an empty filter result", () => {
    const html = renderToStaticMarkup(<ReportsEmpty filtered />);
    expect(html).toContain("No reports match this filter");
  });
});

describe("ReportFilters", () => {
  it("composes state and type into hrefs, dropping defaults", () => {
    expect(reportsHref("all", "all")).toBe("/incidents/reports");
    expect(reportsHref("draft", "all")).toBe("/incidents/reports?state=draft");
    expect(reportsHref("draft", "maintenance")).toBe("/incidents/reports?state=draft&type=maintenance");
  });

  it("appends the pagination cursor while preserving filters", () => {
    expect(reportsHref("all", "all", "abc123")).toBe("/incidents/reports?cursor=abc123");
    expect(reportsHref("draft", "maintenance", "abc123")).toBe(
      "/incidents/reports?state=draft&type=maintenance&cursor=abc123",
    );
    expect(reportsHref("draft", "all", null)).toBe("/incidents/reports?state=draft");
  });

  it("marks the active state and preserves the other dimension", () => {
    const html = renderToStaticMarkup(<ReportFilters state="draft" type="maintenance" />);
    expect(html).toContain('href="/incidents/reports?state=draft&amp;type=maintenance"');
    expect(html).toContain('href="/incidents/reports?state=ongoing&amp;type=maintenance"');
    expect(html).toContain('href="/incidents/reports?state=draft"');
    const activeCount = (html.match(/aria-current="page"/g) ?? []).length;
    expect(activeCount).toBe(2);
  });
});

describe("ReportListPagination", () => {
  it("renders nothing on a single page", () => {
    expect(
      renderToStaticMarkup(<ReportListPagination state="all" type="all" cursor={null} nextCursor={null} />),
    ).toBe("");
  });

  it("links older reports through nextCursor and preserves filters", () => {
    const html = renderToStaticMarkup(
      <ReportListPagination state="draft" type="maintenance" cursor={null} nextCursor="abc123" />,
    );
    expect(html).toContain('href="/incidents/reports?state=draft&amp;type=maintenance&amp;cursor=abc123"');
    expect(html).toContain("Older reports");
    expect(html).not.toContain("Newer reports");
  });

  it("offers a newer-reports affordance while a cursor is active", () => {
    const html = renderToStaticMarkup(
      <ReportListPagination state="ongoing" type="all" cursor="abc123" nextCursor={null} />,
    );
    expect(html).toContain('href="/incidents/reports?state=ongoing"');
    expect(html).toContain("Newer reports");
    expect(html).not.toContain("Older reports");
  });
});
